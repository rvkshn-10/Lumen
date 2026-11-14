"""Track A endpoints. Fixed-site comparisons never filter or re-rank the inputs."""

from __future__ import annotations

import base64
import hashlib
import json
from datetime import UTC, datetime, timedelta
from functools import lru_cache

import numpy as np
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import Field
from spiceypy.utils.exceptions import SpiceyError

from app.global_api import GLOBAL_ROOT, GlobalPointRequest, preview_calculation
from app.models import CompareRequest, Coordinate, PowerSettings, SearchRequest, StrictModel
from app.services.bounded_analysis import bounded_analysis
from app.services.dataset import DataUnavailable
from app.services.ephemeris import load_kernels
from app.services.proximity import great_circle_km
from app.services.repository import load_area, release_metadata, selected_metrics
from app.services.result_cache import cached_result
from app.services.search import analyze_batch
from app.services.sites import SiteNotFound, site_analysis
from app.services.terrain_store import UnknownSite
from app.services.validation import SearchValidationError, validate_search
from app.settings import REPOSITORY_ROOT, settings

router = APIRouter(prefix="/api/v1")
CURATED_PATH = REPOSITORY_ROOT / "apps/web/src/data/curated-sites.json"


def curated_catalog():
    return json.loads(CURATED_PATH.read_text(encoding="utf-8"))


@router.get("/curated-sites")
def curated_sites():
    return curated_catalog()


def source_identity(*, polar=True):
    metadata = release_metadata(settings.data_root) if polar else None
    # Input changes invalidate results before an isolated worker can reuse them.
    inputs = []
    if polar:
        if (settings.data_root / "catalog.json").exists():
            from app.services.repository import store

            for tile in store(settings.data_root).catalog()["tiles"]:
                inputs.extend([settings.data_root / tile["id"] / "terrain.npz",
                               settings.data_root / tile["id"] / "metadata.json"])
            inputs.extend(path for path in (settings.data_root / "features.json",
                                             settings.data_root / "terrain.json",
                                             settings.data_root / "psr.json") if path.exists())
        else:
            inputs.extend(settings.data_root / name for name in metadata["artifacts"])
    inputs.extend(path for path in (GLOBAL_ROOT / "metadata.json", GLOBAL_ROOT / "elevation.npz")
                  if path.exists())
    stamps = [(str(path), path.stat().st_size, path.stat().st_mtime_ns) for path in inputs]
    code_root = REPOSITORY_ROOT / "backend/app"
    algorithm = hashlib.sha256(b"".join((code_root / name).read_bytes() for name in (
        "v2_api.py", "services/search.py", "services/sites.py", "services/candidate_extras.py",
        "services/power.py", "services/events.py", "services/alternatives.py", "global_api.py"))).hexdigest()
    return json.dumps({"root": str(settings.data_root), "terrain": metadata,
                       "algorithm_sha256": algorithm,
                       "input_stamps": stamps,
                       "kernels": load_kernels(settings.kernel_root),
                       "global": (GLOBAL_ROOT / "metadata.json").read_text()
                       if (GLOBAL_ROOT / "metadata.json").exists() else None,
                       "catalog": hashlib.sha256(CURATED_PATH.read_bytes()).hexdigest()}, sort_keys=True)


def scientific_error(exc):
    if isinstance(exc, (SiteNotFound, UnknownSite)):
        return HTTPException(404, str(exc))
    if isinstance(exc, SearchValidationError):
        return HTTPException(422, str(exc))
    return HTTPException(503, {"code": "scientific_data_not_prepared", "message": str(exc)})


@router.post("/compare")
async def compare(payload: CompareRequest, request: Request):
    return JSONResponse(await bounded_analysis("compare", payload.model_dump(mode="json"), request))


def compare_calculation(payload: CompareRequest):
    try:
        mission = SearchRequest(region={"selector_type": "full_supported_region"},
                                **payload.model_dump(exclude={"sites"}))
        validate_search(mission, point_only=True)
        payload = payload.model_copy(update={"time_range": mission.time_range,
                                             "scrub_time_utc": mission.scrub_time_utc})
        needs_polar = any(site.site_id is not None or site.latitude_deg <= -87 for site in payload.sites)
        serialized, identity = payload.model_dump_json(), source_identity(polar=needs_polar)
        return cached_result("compare", serialized, identity, lambda: _compare(serialized, identity))
    except (SiteNotFound, SearchValidationError, DataUnavailable, OSError, ValueError, SpiceyError) as exc:
        raise scientific_error(exc) from exc


@lru_cache(maxsize=2)
def _compare(serialized: str, identity: str):
    payload = CompareRequest.model_validate_json(serialized)
    candidates = []
    seen = set()
    for location in payload.sites:
        mission = SearchRequest(region={"selector_type": "full_supported_region"},
                                **payload.model_dump(exclude={"sites"}))
        validate_search(mission, point_only=True)
        site_id = location.site_id
        if site_id is None and location.latitude_deg <= -87:
            from app.models import RegionSelection

            area = RegionSelection(selector_type="circle", search_radius_km=1,
                                   center=Coordinate(latitude_deg=location.latitude_deg,
                                                     longitude_deg_east=location.longitude_deg_east))
            _, arrays = load_area(settings.data_root, area)
            distance = great_circle_km(arrays["lat_deg"], arrays["lon_deg"],
                                       location.latitude_deg, location.longitude_deg_east)
            exact = np.flatnonzero(distance < 1e-6)
            if len(exact):
                site_id = str(arrays["ids"][exact[0]])
        if site_id is not None:
            detail = site_analysis(site_id, mission, include_alternatives=False)
            candidate = {**detail["site"], **{k: v for k, v in detail.items() if k != "site"},
                         "rank": None, "analysis": "detailed"}
        else:
            coarse = preview_calculation(GlobalPointRequest(
                coordinate={"latitude_deg": location.latitude_deg,
                            "longitude_deg_east": location.longitude_deg_east},
                time_range=payload.time_range, power=payload.power,
                dte_margin_deg=payload.dte_margin_deg))
            candidate = {"id": f"coarse:{location.latitude_deg}:{location.longitude_deg_east}",
                         **coarse["coordinate"], **{k: v for k, v in coarse.items()
                                                    if k not in ("coordinate", "terrain")},
                         "rank": None, "score": None, "analysis": "coarse",
                         "slope_deg": None, "roughness_m": None,
                         "criteria_scores": {key: None for key in payload.preferences.model_dump()}}
            candidate["constraint_status"] = {"passes": None, "reason": "Coarse comparisons do not evaluate detailed mission constraints."}
            if payload.scrub_time_utc is not None:
                from app.services.events import next_events

                candidate.update(next_events(candidate["events"], payload.scrub_time_utc))
        position = (candidate["latitude_deg"], candidate["longitude_deg_east"])
        if abs(position[0]) == 90:
            position = (position[0], 0)
        if position in seen:
            raise SearchValidationError("Comparison resolves to duplicate locations.")
        seen.add(position)
        candidates.append(candidate)
    return {"request": payload.model_dump(mode="json"), "candidates": candidates,
            "common_window": {**payload.time_range.model_dump(mode="json"), "step_minutes": 5},
            "ranking": "none; input order preserved", "warnings": [
                "Coarse and detailed terrain have different sampling; coarse sites have no terrain-safety score."],
            "comparison_id": hashlib.sha256((serialized + identity).encode()).hexdigest()[:20]}


class ReplayRequest(StrictModel):
    dte_margin_deg: float = Field(default=2, ge=0, le=90)
    power: PowerSettings = Field(default_factory=PowerSettings)


@router.post("/historic/{site_id}/replay")
async def replay(site_id: str, request: Request, payload: ReplayRequest | None = None):
    if not any(s["id"] == site_id and s["kind"] == "historic" for s in curated_catalog()["sites"]):
        raise HTTPException(404, "Unknown historic landing.")
    return JSONResponse(await bounded_analysis("replay", {
        "site_id": site_id, **(payload or ReplayRequest()).model_dump(mode="json")}, request))


def replay_calculation(site_id: str, payload: ReplayRequest):
    try:
        serialized, identity = payload.model_dump_json(), source_identity(polar=False)
        return cached_result(f"replay-{site_id}", serialized, identity,
                             lambda: _replay(site_id, serialized, identity))
    except (SiteNotFound, SearchValidationError, DataUnavailable, OSError, ValueError, SpiceyError) as exc:
        raise scientific_error(exc) from exc


@lru_cache(maxsize=2)
def _replay(site_id: str, serialized: str, identity: str):
    del identity
    payload = ReplayRequest.model_validate_json(serialized)
    site = next((row for row in curated_catalog()["sites"]
                 if row["id"] == site_id and row["kind"] == "historic"), None)
    if site is None:
        raise SiteNotFound("Unknown historic landing.")
    landing = datetime.fromisoformat(site["landing_utc"]).astimezone(UTC)
    coordinate = {key: site[key] for key in ("latitude_deg", "longitude_deg_east")}

    def calculate(start, end):
        return preview_calculation(GlobalPointRequest(coordinate=coordinate,
            time_range={"start_utc": start, "end_utc": end}, **payload.model_dump()), historic=True)

    around = calculate(landing - timedelta(hours=12), landing + timedelta(hours=12))
    window = calculate(landing, landing + timedelta(days=14))
    touchdown = next(row for row in window["timeline"] if datetime.fromisoformat(row["time_utc"]) == landing)
    return {"site": site, "landing_utc": site["landing_utc"], "touchdown": touchdown,
            "landing_day": around, "mission_window": window,
            "candidate": {"id": site_id, **coordinate, "analysis": "coarse", **window},
            "warnings": ["Flat-horizon educational replay, not a reconstruction of local terrain shadows."]}


@router.get("/layers/metrics")
async def metrics_layer(request: Request, window: str = Query(max_length=100)):
    """window=start_utc/end_utc. Columns use uint8 0–254; 255 means unknown."""
    try:
        start, end = window.split("/")
        mission = SearchRequest(region={"selector_type": "full_supported_region"},
                                time_range={"start_utc": start, "end_utc": end})
    except ValueError as exc:
        raise HTTPException(422, "Use window=start_utc/end_utc with explicit UTC offsets.") from exc
    return JSONResponse(await bounded_analysis("metrics", mission.model_dump(mode="json"), request))


def metrics_calculation(mission: SearchRequest):
    try:
        validate_search(mission)
        serialized, identity = mission.model_dump_json(), source_identity()
        return cached_result("metrics", serialized, identity, lambda: _metrics(serialized, identity))
    except (SearchValidationError, DataUnavailable, OSError, ValueError, SpiceyError) as exc:
        raise scientific_error(exc) from exc


@lru_cache(maxsize=2)
def _metrics(serialized, identity):
    del identity
    mission = SearchRequest.model_validate_json(serialized)
    metadata, arrays = load_area(settings.data_root, mission.region)
    indices = np.arange(len(arrays["ids"]))
    start, end = mission.time_range.start_utc, mission.time_range.end_utc
    from app.services.repository import is_tiled

    if is_tiled(settings.data_root):
        rows = selected_metrics(settings.data_root, metadata, arrays, indices,
                                settings.kernel_root, start, end)
    else:
        from app.services.ephemeris import body_positions

        times, sun, earth = body_positions(settings.kernel_root, start, end, 5)
        rows = []
        for offset in range(0, len(indices), 32):
            rows.extend(analyze_batch(arrays, indices[offset:offset + 32], times, sun, earth))
    duration = (end - start).total_seconds() / 3600
    columns = {}
    for key, values, low, high in (
        ("illumination_fraction", [row["illumination_fraction"] for row in rows], 0, 1),
        ("earth_visibility_fraction", [row["earth_visibility_fraction"] for row in rows], 0, 1),
        ("slope_deg", arrays["slope_deg"], 0, 90),
        ("elevation_m", arrays["elevation_m"], -11000, 11000),
        ("longest_darkness_hours", [row["longest_darkness_hours"] for row in rows], 0, duration),
    ):
        values = np.asarray(values)
        quantized = np.where(np.isfinite(values),
                             np.rint(np.clip((values - low) / (high - low), 0, 1) * 254), 255).astype(np.uint8)
        columns[key] = {"encoding": "base64-uint8", "data": base64.b64encode(quantized).decode(),
                        "offset": low, "scale": (high - low) / 254, "unknown": 255}
    return {"dataset_version": metadata["dataset_version"], "window": mission.time_range.model_dump(mode="json"),
            "site_ids": arrays["ids"].tolist(), "count": len(rows), "columns": columns,
            "quantization": "round to nearest, decode = offset + uint8 * scale; 255 is unknown",
            "metric_columns_bytes": len(rows) * len(columns),
            "warnings": ["Quantized display columns are not authoritative hard-constraint or ranking inputs."]}
