from __future__ import annotations

import hashlib
import json
import os
from datetime import UTC
from functools import lru_cache
from itertools import pairwise
from pathlib import Path
from time import perf_counter

import numpy as np

from app.models import SearchRequest, SelectorType
from app.services.dataset import dataset
from app.services.ephemeris import (
    FRAME,
    SUN_RADIUS_KM,
    blocker_coordinates,
    body_positions,
    horizon_at,
    load_kernels,
    local_sky,
    solar_disk_fraction,
    visibility_metrics,
)
from app.services.profiling import phase
from app.services.proximity import with_proximity
from app.services.repository import is_tiled, load_area, selected_metrics, store
from app.services.scoring_reference import scoring_reference
from app.services.suitability import LEGEND, suitability_class
from app.services.validation import SearchValidationError, validate_search
from app.settings import settings

# Leaderboard length: spatially separated sites that get full timelines and power models.
SHORTLIST_SIZE = max(1, min(20, int(os.getenv("LUMEN_SHORTLIST_SIZE", "10"))))

METRIC_KEYS = (
    "illumination_fraction",
    "earth_visibility_fraction",
    "longest_sunlight_hours",
    "longest_darkness_hours",
    "longest_communication_hours",
    "longest_blackout_hours",
    "mean_visible_solar_disk_fraction",
)
TEMPORAL_CACHE_VERSION = 1


def dataset_fingerprint(metadata: dict, arrays: dict) -> str:
    return hashlib.sha256(json.dumps({
        "artifacts": metadata["artifacts"],
        "scoring_reference": scoring_reference(metadata, arrays),
        "catalog_sha256": metadata.get("catalog_sha256"),
    }, sort_keys=True).encode()).hexdigest()


def temporal_cache_verified(path: Path, key: str) -> bool:
    try:
        integrity = json.loads(path.with_suffix(".json").read_text())
        return (integrity["key"] == key and path.stat().st_size == integrity["bytes"]
                and hashlib.sha256(path.read_bytes()).hexdigest() == integrity["sha256"])
    except (OSError, ValueError, KeyError, TypeError):
        return False


def region_mask(request: SearchRequest, arrays: dict) -> np.ndarray:
    if request.region.selector_type == SelectorType.full_supported_region:
        return np.ones(len(arrays["lat_deg"]), dtype=bool)
    center = request.region.center
    if center is None or request.region.search_radius_km is None:
        raise SearchValidationError("This selector requires a center and radius.")
    lat, lon = np.deg2rad(arrays["lat_deg"]), np.deg2rad(arrays["lon_deg"])
    clat, clon = np.deg2rad([center.latitude_deg, center.longitude_deg_east])
    hav = np.sin((lat - clat) / 2) ** 2 + np.cos(lat) * np.cos(clat) * np.sin((lon - clon) / 2) ** 2
    distance = 2 * 1737.4 * np.arcsin(np.sqrt(np.clip(hav, 0, 1)))
    return distance <= request.region.search_radius_km


def terrain_mask(request: SearchRequest, arrays: dict) -> np.ndarray:
    c = request.hard_constraints
    mask = np.ones(len(arrays["lat_deg"]), dtype=bool)
    checks = [
        ("slope_deg", c.maximum_slope_deg, False),
        ("roughness_m", c.maximum_roughness_m, False),
        ("elevation_m", c.minimum_elevation_m, True),
        ("elevation_m", c.maximum_elevation_m, False),
        ("distance_psr_km", c.maximum_distance_to_psr_km, False),
        ("distance_science_feature_km", c.maximum_distance_to_science_feature_km, False),
    ]
    for key, limit, minimum in checks:
        if limit is not None:
            mask &= arrays[key] >= limit if minimum else arrays[key] <= limit
    return mask


def temporal_pass(request: SearchRequest, metrics: dict) -> bool:
    c = request.hard_constraints
    checks = [
        ("illumination_fraction", c.minimum_illumination_fraction, True),
        ("earth_visibility_fraction", c.minimum_earth_visibility_fraction, True),
        ("longest_sunlight_hours", c.minimum_continuous_sunlight_hours, True),
        ("longest_darkness_hours", c.maximum_continuous_darkness_hours, False),
        ("longest_communication_hours", c.minimum_continuous_communication_hours, True),
        ("longest_blackout_hours", c.maximum_continuous_blackout_hours, False),
    ]
    return all(
        limit is None or (metrics[key] >= limit if minimum else metrics[key] <= limit)
        for key, limit, minimum in checks
    )


def analyze(arrays: dict, i: int, times, sun, earth, *, timeline: bool = False) -> dict:
    lat, lon, height = (float(arrays[key][i]) for key in ("lat_deg", "lon_deg", "elevation_m"))
    saz, sel, sd = local_sky(lat, lon, height, sun)
    eaz, eel, _ = local_sky(lat, lon, height, earth)
    profile = arrays["horizons_deg"][i]
    sh, eh = horizon_at(profile, saz), horizon_at(profile, eaz)
    radius = np.rad2deg(np.arcsin(SUN_RADIUS_KM / sd))
    sf = solar_disk_fraction(sel - sh, radius)
    sunlight, communication = sel + radius > sh, eel > eh
    hours = np.array([(b - a).total_seconds() / 3600 for a, b in pairwise(times)])
    illumination, sunlong, darklong = visibility_metrics(sunlight, hours)
    visibility, earthlong, blackout = visibility_metrics(communication, hours)
    result = {
        "metrics": {
            "illumination_fraction": illumination,
            "earth_visibility_fraction": visibility,
            "longest_sunlight_hours": sunlong,
            "longest_darkness_hours": darklong,
            "longest_communication_hours": earthlong,
            "longest_blackout_hours": blackout,
            "mean_visible_solar_disk_fraction": float(np.sum(sf[:-1] * hours) / hours.sum()),
        }
    }
    if timeline:
        result["timeline"] = [
            {
                "time_utc": t.isoformat().replace("+00:00", "Z"),
                "sun_azimuth_deg": float(saz[j]),
                "sun_elevation_deg": float(sel[j]),
                "earth_azimuth_deg": float(eaz[j]),
                "earth_elevation_deg": float(eel[j]),
                "sun_horizon_deg": float(sh[j]),
                "earth_horizon_deg": float(eh[j]),
                "solar_fraction": float(sf[j]),
                "sun_visible": bool(sunlight[j]),
                "earth_visible": bool(communication[j]),
            }
            for j, t in enumerate(times)
        ]
        result["horizon"] = [
            {
                "azimuth_deg": float(j * 360 / len(profile)),
                "elevation_deg": float(h),
                "distance_m": float(arrays["blocker_distance_m"][i, j]),
            }
            for j, h in enumerate(profile)
        ]
        for row in result["horizon"]:
            blocker_lat, blocker_lon = blocker_coordinates(
                lat, lon, row["azimuth_deg"], row["distance_m"]
            )
            row.update(blocker_latitude_deg=blocker_lat, blocker_longitude_deg_east=blocker_lon)
    return result


def _longest_runs(states: np.ndarray, hours: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Duration of the longest visible and blocked runs for each site."""
    edges = np.concatenate(([0.0], np.cumsum(hours)))
    starts = np.zeros(states.shape, dtype=np.int32)
    starts[:, 1:] = np.where(states[:, 1:] != states[:, :-1], np.arange(1, states.shape[1]), 0)
    np.maximum.accumulate(starts, axis=1, out=starts)
    durations = edges[1:][None, :] - edges[starts]
    visible = np.max(np.where(states, durations, 0.0), axis=1)
    blocked = np.max(np.where(~states, durations, 0.0), axis=1)
    return np.round(visible, 9), np.round(blocked, 9)


def search_threads() -> int:
    """Worker threads for temporal batches. NumPy releases the GIL inside each kernel."""
    try:
        return max(1, int(os.getenv("LUMEN_SEARCH_THREADS", "0")) or min(8, os.cpu_count() or 1))
    except ValueError:
        return 1


def evaluate_many(arrays: dict, indices, times, sun, earth, batch: int = 32) -> list[dict]:
    """Per-site metrics for many sites.

    Every site is still evaluated by the same batch function with the same batch
    boundaries, so results are bit-for-bit identical to the serial loop; the
    batches simply run on several cores.
    """
    indices = np.asarray(indices)
    chunks = [indices[offset : offset + batch] for offset in range(0, len(indices), batch)]
    threads = min(search_threads(), len(chunks))
    if threads <= 1:
        rows = []
        for chunk in chunks:
            rows.extend(evaluate_metrics(arrays, chunk, times, sun, earth))
        return rows
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(max_workers=threads, thread_name_prefix="lumen-temporal") as pool:
        parts = list(pool.map(lambda chunk: evaluate_metrics(arrays, chunk, times, sun, earth), chunks))
    return [row for part in parts for row in part]


def analyze_batch(arrays: dict, indices: np.ndarray, times, sun, earth) -> list[dict]:
    """Evaluate a bounded group of sites on the same scientific time grid."""
    lat = np.deg2rad(arrays["lat_deg"][indices])
    lon = np.deg2rad(arrays["lon_deg"][indices])
    cos_lat, sin_lat = np.cos(lat), np.sin(lat)
    cos_lon, sin_lon = np.cos(lon), np.sin(lon)
    up = np.stack((cos_lat * cos_lon, cos_lat * sin_lon, sin_lat), axis=1)
    east = np.stack((-sin_lon, cos_lon, np.zeros_like(lon)), axis=1)
    north = np.cross(up, east)
    observer_km = up * ((1_737_400 + arrays["elevation_m"][indices] + 2) / 1000)[:, None]
    profile = arrays["horizons_deg"][indices]

    def direction(body):
        vectors = body[None, :, :] - observer_km[:, None, :]
        distance = np.linalg.norm(vectors, axis=2)
        azimuth = (
            np.rad2deg(
                np.arctan2(
                    np.einsum("bti,bi->bt", vectors, east),
                    np.einsum("bti,bi->bt", vectors, north),
                )
            )
            % 360
        )
        elevation = np.rad2deg(
            np.arcsin(np.clip(np.einsum("bti,bi->bt", vectors, up) / distance, -1, 1))
        )
        bins = azimuth * profile.shape[1] / 360
        lo = np.floor(bins).astype(np.int32) % profile.shape[1]
        horizon = np.maximum(
            np.take_along_axis(profile, lo, axis=1),
            np.take_along_axis(profile, (lo + 1) % profile.shape[1], axis=1),
        )
        return elevation, horizon, distance

    sun_elevation, sun_horizon, sun_distance = direction(sun)
    earth_elevation, earth_horizon, _ = direction(earth)
    sun_radius = np.rad2deg(np.arcsin(SUN_RADIUS_KM / sun_distance))
    sunlight = sun_elevation + sun_radius > sun_horizon
    communication = earth_elevation > earth_horizon
    hours = np.array([(b - a).total_seconds() / 3600 for a, b in pairwise(times)])
    total_hours = hours.sum()
    illumination = np.sum(sunlight[:, :-1] * hours, axis=1) / total_hours
    visibility = np.sum(communication[:, :-1] * hours, axis=1) / total_hours
    sunlong, darklong = _longest_runs(sunlight[:, :-1], hours)
    earthlong, blackout = _longest_runs(communication[:, :-1], hours)
    disk_fraction = solar_disk_fraction(sun_elevation - sun_horizon, sun_radius)
    mean_disk = np.sum(disk_fraction[:, :-1] * hours, axis=1) / total_hours
    return [
        {
            "illumination_fraction": float(illumination[j]),
            "earth_visibility_fraction": float(visibility[j]),
            "longest_sunlight_hours": float(sunlong[j]),
            "longest_darkness_hours": float(darklong[j]),
            "longest_communication_hours": float(earthlong[j]),
            "longest_blackout_hours": float(blackout[j]),
            "mean_visible_solar_disk_fraction": float(mean_disk[j]),
        }
        for j in range(len(indices))
    ]


def evaluate_metrics(arrays, indices, times, sun, earth):
    if os.getenv("LUMEN_TEMPORAL_KERNEL", "reference") == "compiled":
        from app.services.temporal_kernel import evaluate_batch

        return evaluate_batch(arrays, indices, times, sun, earth)
    return analyze_batch(arrays, indices, times, sun, earth)


@lru_cache(maxsize=2)
def cached_metrics(
    data_root,
    artifact_fingerprint: str,
    kernel_hashes: tuple[str, ...],
    start,
    end,
    indices: tuple[int, ...],
) -> tuple[dict, ...]:
    """Reuse exact five-minute metrics when only ranking preferences change."""
    _, arrays = dataset(data_root)
    path, key = temporal_cache_path(data_root, artifact_fingerprint, kernel_hashes, start, end)
    if temporal_cache_verified(path, key):
        try:
            with np.load(path, allow_pickle=False) as archive:
                if (
                    str(archive["key"]) == key
                    and np.array_equal(archive["ids"], arrays["ids"])
                    and all(len(archive[name]) == len(arrays["ids"]) for name in METRIC_KEYS)
                ):
                    columns = {name: archive[name] for name in METRIC_KEYS}
                    return tuple(
                        {name: float(columns[name][i]) for name in METRIC_KEYS} for i in indices
                    )
        except (OSError, ValueError, KeyError):
            pass  # A stale or damaged optional cache cannot change science results.
    times, sun, earth = body_positions(settings.kernel_root, start, end, 5)
    return tuple(evaluate_many(arrays, np.asarray(indices, dtype=np.int32), times, sun, earth, batch=64))


def temporal_cache_path(
    data_root: Path, artifact_fingerprint: str, kernel_hashes: tuple[str, ...], start, end
) -> tuple[Path, str]:
    from app.services.result_cache import code_revision

    key = hashlib.sha256(
        json.dumps(
            {
                "version": TEMPORAL_CACHE_VERSION,
                "code_revision": code_revision(),
                "artifacts": artifact_fingerprint,
                "kernels": kernel_hashes,
                "start": start.isoformat(),
                "end": end.isoformat(),
                "step_minutes": 5,
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()
    return data_root.parents[1] / "cache/temporal" / f"{key}.npz", key


def precompute_temporal_cache(start, end) -> Path:
    """Write exact metrics for every prepared site in one pinned mission window."""
    metadata, arrays = dataset(settings.data_root)
    kernels = load_kernels(settings.kernel_root)
    fingerprint = dataset_fingerprint(metadata, arrays)
    hashes = tuple(item["sha256"] for item in kernels)
    path, key = temporal_cache_path(settings.data_root, fingerprint, hashes, start, end)
    if temporal_cache_verified(path, key):
        try:
            with np.load(path, allow_pickle=False) as archive:
                if (
                    str(archive["key"]) == key
                    and np.array_equal(archive["ids"], arrays["ids"])
                    and all(len(archive[name]) == len(arrays["ids"]) for name in METRIC_KEYS)
                ):
                    return path
        except (OSError, ValueError, KeyError):
            pass
    indices = tuple(range(len(arrays["ids"])))
    rows = cached_metrics(settings.data_root, fingerprint, hashes, start, end, indices)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".partial.npz")
    np.savez_compressed(
        temporary,
        key=np.array(key),
        ids=arrays["ids"],
        **{name: np.asarray([row[name] for row in rows], dtype=np.float64) for name in METRIC_KEYS},
    )
    temporary.replace(path)
    integrity = {"key": key, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                 "bytes": path.stat().st_size}
    temporary_manifest = path.with_suffix(".partial.json")
    temporary_manifest.write_text(json.dumps(integrity, indent=2))
    temporary_manifest.replace(path.with_suffix(".json"))
    return path


def category_scores(
    metrics: dict,
    slope: float,
    roughness: float,
    elevation: float,
    duration_hours: float,
    anchors: dict,
) -> dict:
    def utility(value: float, key: str, higher: bool = False) -> float:
        low, high = anchors[key]
        if high <= low:
            return 0.5
        normalized = min(1.0, max(0.0, (value - low) / (high - low)))
        return normalized if higher else 1 - normalized

    safety = (
        0.45 * utility(slope, "slope_deg")
        + 0.35 * utility(roughness, "roughness_m")
        + 0.20 * utility(elevation, "elevation_m", True)
    )
    return {
        "illumination": 0.5 * metrics["illumination_fraction"]
        + 0.25 * metrics["longest_sunlight_hours"] / duration_hours
        + 0.25 * (1 - metrics["longest_darkness_hours"] / duration_hours),
        "earth_visibility": 0.5 * metrics["earth_visibility_fraction"]
        + 0.25 * metrics["longest_communication_hours"] / duration_hours
        + 0.25 * (1 - metrics["longest_blackout_hours"] / duration_hours),
        "terrain_safety": float(safety),
        "science_proximity": None,
    }


def map_sample_reference(ranked: list[tuple], arrays: dict, selected: list[tuple], limit: int = 5000):
    """Keep top scoring points per spatial cell and every shortlisted point."""
    if len(ranked) <= limit:
        return ranked
    selected_ids = {row[1] for row in selected}
    x, y = arrays["x_m"], arrays["y_m"]
    side = max(float(np.ptp(x)), float(np.ptp(y))) / np.sqrt(limit - len(selected_ids))
    while True:
        occupied = set()
        sampled = []
        for row in ranked:
            i = row[2]
            cell = (int(np.floor(x[i] / side)), int(np.floor(y[i] / side)))
            if row[1] in selected_ids or cell not in occupied:
                sampled.append(row)
                occupied.add(cell)
        if len(sampled) <= limit:
            return sampled
        side *= 1.2


def map_sample(ranked: list[tuple], arrays: dict, selected: list[tuple], limit: int = 5000):
    """Same first-in-cell sample as the reference, with vectorized cell lookup."""
    if len(ranked) <= limit:
        return ranked
    selected_ids = {row[1] for row in selected}
    indices = np.fromiter((row[2] for row in ranked), dtype=np.intp, count=len(ranked))
    mandatory = np.fromiter((row[1] in selected_ids for row in ranked), dtype=bool,
                            count=len(ranked))
    x, y = arrays["x_m"], arrays["y_m"]
    side = max(float(np.ptp(x)), float(np.ptp(y))) / np.sqrt(limit - len(selected_ids))
    ranked_x = np.asarray(x[indices], dtype=np.float64)
    ranked_y = np.asarray(y[indices], dtype=np.float64)
    while True:
        cells = np.column_stack((np.floor(ranked_x / side), np.floor(ranked_y / side)))
        _, first = np.unique(cells, axis=0, return_index=True)
        keep = mandatory.copy()
        keep[first] = True
        if np.count_nonzero(keep) <= limit:
            return [ranked[i] for i in np.flatnonzero(keep)]
        side *= 1.2


def search(request: SearchRequest, *, timings: dict | None = None, prepared=None) -> dict:
    started = perf_counter()
    with phase("validation"):
        validation = validate_search(request, hemisphere=prepared is not None)
    with phase("load_area"):
        metadata, arrays = prepared if prepared is not None else (load_area(settings.data_root, request.region, scalar_only=True) if is_tiled(settings.data_root) else dataset(settings.data_root))
        arrays = with_proximity(
            arrays, request.hard_constraints.science_feature_ids, settings.data_root
        )
    kernels = load_kernels(settings.kernel_root)
    weights = validation.normalized_preferences.model_dump()
    science_available = "distance_psr_km" in arrays or "distance_science_feature_km" in arrays
    if not science_available:
        weights["science_proximity"] = 0
    total = sum(weights.values())
    if total == 0:
        weights.update(illumination=0.4, earth_visibility=0.4, terrain_safety=0.2)
        total = 1
    weights = {k: v / total for k, v in weights.items()}
    warnings = validation.warnings + [
        f"Full-region means the prepared coverage: {metadata['coverage']['description']}.",
        "Visibility uses 5-minute samples; transition and longest-interval uncertainty is at least one sample.",
        "A solar upper-limb sighting counts as sunlight; disk fraction is geometric, not usable power.",
        "Earth visibility is geometric Earth-center line of sight, not a communications link budget.",
        "Blocker coordinates approximate sampled ray bearings and ranges on the reference sphere; they are not surveyed ridge locations.",
    ]
    if request.preferences.science_proximity > 0 and not science_available:
        warnings.append(
            "Science/PSR proximity is unavailable; its preference weight is redistributed."
        )
    if "distance_psr_km" in arrays:
        warnings.append(
            "PSR proximity is distance to modeled permanent-shadow pixel areas, not evidence of ice, resources, or traversability."
        )
    if request.hard_constraints.science_feature_ids:
        warnings.append(
            "Named-feature distance is to the nearest selected approved center point, not a crater rim or a surface route."
        )
    start, end = (
        t.astimezone(UTC) for t in (request.time_range.start_utc, request.time_range.end_utc)
    )
    reference = scoring_reference(metadata, arrays)
    anchors = reference["bounds"]
    duration_hours = (end - start).total_seconds() / 3600
    with phase("region_mask"):
        mask = np.ones(len(arrays["lat_deg"]),dtype=bool) if prepared is not None else region_mask(request, arrays)
    with phase("terrain_mask"):
        terrain = mask & terrain_mask(request, arrays)
        indices = np.flatnonzero(terrain)
    filtered_at = perf_counter()
    with phase("body_positions"):
        times, sun, earth = body_positions(settings.kernel_root, start, end, 5)
    ephemeris_at = perf_counter()
    with phase("cached_metrics"):
        artifact_fingerprint = dataset_fingerprint(metadata, arrays)
        if prepared is not None:
            metrics_rows = evaluate_many(arrays, indices, times, sun, earth)
        else:
            metrics_rows = selected_metrics(settings.data_root, metadata, arrays, indices, settings.kernel_root, start, end, columnar=True) if is_tiled(settings.data_root) else cached_metrics(
                settings.data_root,
                artifact_fingerprint,
                tuple(item["sha256"] for item in kernels),
                start,
                end,
                tuple(int(i) for i in indices),
            )
    with phase("category_scores"):
        from app.services.ranking import rank_columns

        ranked, materialize = rank_columns(
            request, arrays, indices, metrics_rows, weights, duration_hours, anchors
        )
    analyzed_at = perf_counter()
    with phase("sort_separation"):
        ranked.sort(key=lambda item: (-item[0], item[1]))
        selected = []
        for row in ranked:
            i = row[2]
            if all(
                np.hypot(arrays["x_m"][i] - arrays["x_m"][r[2]], arrays["y_m"][i] - arrays["y_m"][r[2]])
                >= 1500
                for r in selected
            ):
                selected.append(row)
            if len(selected) == SHORTLIST_SIZE:
                break
    with phase("map_sample"):
        map_ranked = [materialize(row) for row in map_sample(ranked, arrays, selected)]
        selected = [materialize(row) for row in selected]
    with phase("shortlist_details"):
        candidates = []
        for rank, (score, site_id, i, scores, metrics) in enumerate(selected, 1):
            detail_arrays, detail_i = arrays, i
            if "horizons_deg" not in arrays:
                detail_arrays = store(settings.data_root).site(site_id)
                detail_i = 0
            detail = analyze(detail_arrays, detail_i, times, sun, earth, timeline=True)
            from app.services.candidate_extras import enrich
            from app.services.sites import visible_at

            sun_distance = local_sky(float(arrays["lat_deg"][i]), float(arrays["lon_deg"][i]),
                                     float(arrays["elevation_m"][i]), sun)[2]
            enrich(detail, request, lambda instant, body, index=detail_i, source=detail_arrays: visible_at(source, index, instant, body),
                   sun_distance=sun_distance)
            candidates.append(
                {
                    "id": site_id,
                    "rank": rank,
                    "score": score,
                    "latitude_deg": float(arrays["lat_deg"][i]),
                    "longitude_deg_east": float(arrays["lon_deg"][i]),
                    **{
                        key: float(arrays[key][i])
                        for key in ("x_m", "y_m", "elevation_m", "slope_deg", "roughness_m")
                    },
                    "criteria_scores": scores,
                    **{
                        key: float(arrays[key][i])
                        for key in ("distance_psr_km", "distance_science_feature_km")
                        if key in arrays
                    },
                    **detail,
                }
            )
    request_json = request.model_dump(mode="json")
    provenance = {
        "engine_version": "exploration-2.0.0",
        "power_model": "ideal-direct-solar-1",
        "event_refinement_seconds": 60,
        "dte_margin_deg": request.dte_margin_deg,
        "terrain": metadata,
        "kernels": list(kernels),
        "calculation_frame": FRAME,
        "aberration_correction": {"sun": "CN+S", "earth": "XCN+S"},
        "parallax": "Site position subtracted from apparent Moon-center vectors; lunar-surface observer velocity is not modeled.",
        "observer_height_m": 2,
        "horizon_interpolation": "maximum of adjacent azimuth bins",
        "shortlist_minimum_separation_m": 1500,
        "score_anchors": {
            "reference_id": reference["id"],
            "method": reference.get("method", "fixed hemisphere terrain bounds" if prepared is not None else "full prepared dataset 5th/95th percentiles, clipped linear utility"),
            "bounds": anchors,
            "terrain_weights": {"slope": 0.45, "roughness": 0.35, "elevation": 0.20},
            "elevation_preference": "higher elevation",
            "temporal_weights": {
                "fraction": 0.5,
                "longest_visible_fraction": 0.25,
                "inverse_longest_blocked_fraction": 0.25,
            },
            "science_proximity": {
                "psr_zero_utility_km": 10,
                "feature_zero_utility_km": 50,
                "weights_when_both": {"psr": 0.6, "selected_features": 0.4},
                "feature_distance_definition": "nearest selected approved feature center; not crater edge or travel distance",
            },
        },
        "time_integration": "left sample, duration weighted, mission-end clipped",
    }
    digest = hashlib.sha256(
        json.dumps({"request": request_json, "provenance": provenance}, sort_keys=True).encode()
    ).hexdigest()[:20]
    result = {
        "search_id": digest,
        "status": "complete" if candidates else "empty",
        "request": request_json,
        "candidates": candidates,
        "map_candidates": [
            {
                "id": site_id,
                "x_m": float(arrays["x_m"][i]),
                "y_m": float(arrays["y_m"][i]),
                "latitude_deg": float(arrays["lat_deg"][i]),
                "longitude_deg_east": float(arrays["lon_deg"][i]),
                "score": score,
                "suitability_class": int(suitability_class(score)),
                "illumination_fraction": metrics["illumination_fraction"],
                "earth_visibility_fraction": metrics["earth_visibility_fraction"],
                "slope_deg": float(arrays["slope_deg"][i]),
                "criteria_scores": scores,
                **{
                    key: float(arrays[key][i])
                    for key in ("distance_psr_km", "distance_science_feature_km")
                    if key in arrays
                },
            }
            for score, site_id, i, scores, metrics in map_ranked
        ],
        "map_point_count": len(map_ranked),
        "rejections": {
            "outside_region": metadata["candidate_count"] - int(mask.sum()) if is_tiled(settings.data_root) else int((~mask).sum()),
            "terrain_or_proximity": int(mask.sum()) - len(indices),
            "temporal": len(indices) - len(ranked),
        },
        "counts": {
            "total": metadata["candidate_count"] if is_tiled(settings.data_root) else len(arrays["lat_deg"]),
            "region": int(mask.sum()),
            "terrain_pass": len(indices),
            "temporal_pass": len(ranked),
            "shortlisted": len(candidates),
        },
        "normalized_preferences": weights,
        "assumptions": validation.assumptions,
        "warnings": warnings,
        "provenance": provenance,
        "common_window": {
            "start_utc": start.isoformat(),
            "end_utc": end.isoformat(),
            "step_minutes": 5,
        },
    }
    if prepared is not None:
        result["terrain_data"] = metadata.get("display_terrain")
        if request.region.selector_type == SelectorType.southern_hemisphere:
            result["survey"] = {"scope":"southern_hemisphere", "candidate_spacing_km":151.6166,
                                "candidate_count":len(arrays["ids"]), "refinement_radius_km":5}
            result["warnings"].append("Whole-hemisphere ranking compares regional survey locations about 150 km apart; it does not rank every 500 m point. Use local detailed search to refine the shortlist.")
        result["warnings"].extend([
            "LOLA source spacing is approximately 118 m north-south; gridded terrain misses smaller hazards.",
            "Slope uses central differences over 500 m; roughness is RMS plane residual over a 500 m footprint.",
            "Hemisphere terrain scores use fixed bounds and are not calibrated to polar product scores.",
            "Survey horizons use the approximately 1.9 km global elevation grid, sampled every 2 km to 200 km; detailed local refinement uses the 118 m source." if request.region.selector_type == SelectorType.southern_hemisphere else "Horizon bearings are sampled every 5 degrees, radially about 118 m to 20 km and 472 m to 200 km.",
            "Only southern candidates are ranked when the search circle crosses the equator.",
        ])
    result["suitability_legend"] = LEGEND
    result["alternatives"] = []
    if not candidates and mask.any() and request.region.selector_type != SelectorType.southern_hemisphere:
        from app.services.alternatives import search_alternatives

        if "horizons_deg" not in arrays:
            _, arrays = load_area(settings.data_root, request.region)
            arrays = with_proximity(arrays, request.hard_constraints.science_feature_ids, settings.data_root)
        result["alternatives"] = search_alternatives(request, arrays, mask, times, sun, earth)
    if not candidates:
        result["empty_reason"] = (
            "No prepared candidates intersect the selected region."
            if not mask.any()
            else "No candidates satisfy all hard constraints in this mission window."
        )
    if len(map_ranked) < len(ranked):
        result["warnings"].append(
            "The map displays a spatial sample of eligible points; ranking used every eligible site."
        )
    if timings is not None:
        timings.update(
            filter_s=filtered_at - started,
            ephemeris_s=ephemeris_at - filtered_at,
            analysis_s=analyzed_at - ephemeris_at,
            response_s=perf_counter() - analyzed_at,
        )
    return result
