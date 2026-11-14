"""Bounded, deterministic suggestions; original constraints and requests never mutate."""

from __future__ import annotations

import hashlib
import json
from datetime import timedelta

import numpy as np

from app.models import Coordinate, RegionSelection
from app.services.ephemeris import positions_at_times, time_grid
from app.services.proximity import great_circle_km, with_proximity
from app.services.repository import load_site
from app.services.search import analyze, analyze_batch
from app.services.validation import VALID_END, VALID_START
from app.settings import settings

# constraint, candidate field, direction, human-readable unit
CHECKS = (
    ("maximum_slope_deg", "slope_deg", False, "degrees slope"),
    ("maximum_roughness_m", "roughness_m", False, "m roughness"),
    ("minimum_elevation_m", "elevation_m", True, "m elevation"),
    ("maximum_elevation_m", "elevation_m", False, "m elevation"),
    ("minimum_illumination_fraction", "illumination_fraction", True, "sunlit fraction"),
    ("minimum_earth_visibility_fraction", "earth_visibility_fraction", True, "Earth-view fraction"),
    ("minimum_continuous_sunlight_hours", "longest_sunlight_hours", True, "h continuous sunlight"),
    ("maximum_continuous_darkness_hours", "longest_darkness_hours", False, "h darkness"),
    ("minimum_continuous_communication_hours", "longest_communication_hours", True, "h Earth view"),
    ("maximum_continuous_blackout_hours", "longest_blackout_hours", False, "h Earth blackout"),
    ("maximum_distance_to_psr_km", "distance_psr_km", False, "km PSR distance"),
    ("maximum_distance_to_science_feature_km", "distance_science_feature_km", False, "km feature distance"),
)


def values_at(arrays, index, metrics):
    return {**metrics, **{key: float(arrays[key][index]) for key in
            ("slope_deg", "roughness_m", "elevation_m", "distance_psr_km",
             "distance_science_feature_km") if key in arrays}}


def failures(request, values):
    return [(key, metric, minimum, unit) for key, metric, minimum, unit in CHECKS
            if (limit := getattr(request.hard_constraints, key)) is not None
            and (metric not in values or (values[metric] < limit if minimum
                                         else values[metric] > limit))]


def site_alternatives(request, arrays, index, metrics):
    baseline = values_at(arrays, index, metrics)
    failed = failures(request, baseline)
    if not failed:
        return []
    source_id = str(arrays["ids"][index])
    lat, lon = float(arrays["lat_deg"][index]), float(arrays["lon_deg"][index])
    output = []

    def option(kind, target_id, values, mission, reason, **extra):
        identity = json.dumps([source_id, kind, target_id, mission.model_dump(mode="json")],
                              sort_keys=True)
        return {"id": target_id, "suggestion_id": hashlib.sha256(identity.encode()).hexdigest()[:20],
                "kind": kind, "for_site": source_id, "resolves": [row[0] for row in failed],
                "metrics": {key: values[key] for key in metrics}, "reason": reason,
                "before_metrics": metrics,
                "before_terrain": {key: value for key, value in baseline.items() if key not in metrics},
                "terrain": {key: value for key, value in values.items() if key not in metrics},
                "evaluation_endpoint": f"/api/v1/sites/{target_id}/analysis",
                "request": mission.model_dump(mode="json"), **extra}

    def change_text(values):
        return "; ".join(f"{baseline[metric]:.6g} → {values[metric]:.6g} {unit}"
                         for _, metric, _, unit in failed if metric in values and metric in baseline)

    # Only claim nearest among prepared sites inside this advertised physical radius.
    _, nearby = load_site(settings.data_root, source_id, 5000)
    nearby = with_proximity(nearby, request.hard_constraints.science_feature_ids, settings.data_root)
    distances = great_circle_km(lat, lon, nearby["lat_deg"], nearby["lon_deg"])
    ordered = sorted(np.flatnonzero((distances > 1e-8) & (distances <= 5)),
                     key=lambda j: (float(distances[j]), str(nearby["ids"][j])))
    start, end = request.time_range.start_utc, request.time_range.end_utc
    from app.services.ephemeris import body_positions

    times, sun, earth = body_positions(settings.kernel_root, start, end, 5)
    for offset in range(0, len(ordered), 32):
        indices = np.array(ordered[offset:offset + 32], dtype=int)
        rows = analyze_batch(nearby, indices, times, sun, earth)
        found = False
        for j, row in zip(indices, rows, strict=True):
            values = values_at(nearby, j, row)
            if failures(request, values):
                continue
            mission = request.model_copy(deep=True)
            mission.region = RegionSelection(selector_type="circle", search_radius_km=5,
                                              center=Coordinate(latitude_deg=lat,
                                                                longitude_deg_east=lon))
            output.append(option("nearby", str(nearby["ids"][j]), values, mission,
                                 f"Suggestion: {distances[j]:.3f} km away, {change_text(values)}. "
                                 "Meets every original numeric limit; area changes explicitly.",
                                 distance_km=float(distances[j]), search_radius_km=5))
            found = True
            break
        if found:
            break

    # A date cannot fix static terrain or proximity. Avoid an expensive futile scan.
    temporal = {key for key in metrics}
    if all(metric in temporal for _, metric, _, _ in failed):
        trials = []
        for day in range(1, 31):
            for sign in (-1, 1):  # deterministic tie: earlier date before later date
                shift = timedelta(days=day * sign)
                if VALID_START <= start + shift and end + shift <= VALID_END:
                    trials.append((shift, time_grid(start + shift, end + shift, 5)))
        if trials:
            all_times = sorted({time for _, grid in trials for time in grid})
            all_sun, all_earth = positions_at_times(settings.kernel_root, all_times)
            lookup = {time: j for j, time in enumerate(all_times)}
            for shift, grid in trials:
                positions = [lookup[time] for time in grid]
                changed = analyze(arrays, index, grid, all_sun[positions], all_earth[positions])["metrics"]
                values = values_at(arrays, index, changed)
                if not failures(request, values):
                    mission = request.model_copy(deep=True)
                    mission.time_range.start_utc += shift
                    mission.time_range.end_utc += shift
                    mission.scrub_time_utc = None
                    if mission.region.selector_type == "full_supported_region":
                        mission.region = RegionSelection(selector_type="circle", search_radius_km=1,
                            center=Coordinate(latitude_deg=lat, longitude_deg_east=lon))
                    output.append(option("shifted_window", source_id, values, mission,
                                         f"Suggestion: shift start by {shift.days:+d} days; "
                                         f"{change_text(values)}. Meets every original numeric limit.",
                                         shift_hours=shift.total_seconds() / 3600,
                                         search_radius_km=0))
                    break

    # Minimum change for one constraint, and only if it alone makes the site pass.
    # Multi-constraint failures are never disguised as a single relaxation.
    if len(failed) == 1:
        key, metric, _, unit = failed[0]
        if metric in baseline:
            mission = request.model_copy(deep=True)
            before = getattr(mission.hard_constraints, key)
            setattr(mission.hard_constraints, key, baseline[metric])
            if not failures(mission, baseline):
                output.append(option("relaxed", source_id, baseline, mission,
                                     f"Suggestion: change {key} from {before:.6g} to "
                                     f"{baseline[metric]:.6g} {unit}. This explicitly relaxes one limit.",
                                     relaxation={"constraint": key, "before": before,
                                                 "after": baseline[metric]}))
    return output[:3]


def search_alternatives(request, arrays, mask, times, sun, earth):
    indices = np.flatnonzero(mask)
    if not len(indices):
        return []
    # A documented representative failed location, never presented as a ranked finalist.
    if request.region.center:
        center = request.region.center
        distance = great_circle_km(center.latitude_deg, center.longitude_deg_east,
                                   arrays["lat_deg"][indices], arrays["lon_deg"][indices])
        index = int(indices[np.argmin(distance)])
    else:
        index = int(indices[0])
    metrics = analyze(arrays, index, times, sun, earth)["metrics"]
    return site_alternatives(request, arrays, index, metrics)
