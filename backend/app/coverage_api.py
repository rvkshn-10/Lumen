"""Read-only planning coverage derived from verified candidate data, never display meshes."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from functools import lru_cache

import numpy as np
from fastapi import APIRouter, HTTPException

from app.models import Coordinate, RegionSelection, SearchRequest, SelectorType, TimeRange
from app.services.dataset import dataset
from app.services.proximity import feature_catalog
from app.services.repository import is_tiled, load_area, release_metadata, store
from app.services.search import region_mask
from app.services.search_limits import public_limits
from app.services.terrain_store import digest
from app.settings import settings

router = APIRouter(prefix="/api/v1/coverage")
RADIUS = 1_737_400.0


@lru_cache(maxsize=2)
def catalog_for(root, fingerprint: str):
    del fingerprint
    if is_tiled(root):
        release = store(root).catalog()
        holes = [{"x_m": 0.0, "y_m": 0.0, "reason": "Exact pole excluded", "radius_m": 0}]
        for tile in release["tiles"]:
            path = root / tile["validity_path"]
            artifact = tile["artifacts"]["exclusions.json"]
            if path.stat().st_size != artifact["bytes"] or digest(path) != artifact["sha256"]:
                raise ValueError("Invalid coverage exclusion artifact")
            holes.extend(
                {
                    "x_m": item["x_m"],
                    "y_m": item["y_m"],
                    "reason": item["reason"],
                    "radius_m": 500 / np.sqrt(2),
                }
                for item in json.loads(path.read_text())
            )
        return {
            "dataset_version": release["dataset_version"],
            "catalog_sha256": release["catalog_sha256"],
            "verified": True,
            "label": "Prepared 87°S–90°S lunar south cap",
            "geometry": {
                "type": "cap",
                "extent_m": release["coverage"]["extent_m"],
                "radius_m": float(2 * RADIUS * np.tan(np.deg2rad(3) / 2)),
            },
            "excluded_locations": holes,
            "candidate_count": release["verification"]["verified_candidates"],
            "candidate_spacing_m": 500,
            "layers": {"psr_distance": False, "approved_features": True},
            "public_limits": public_limits(),
            "search_service": {"mode": "synchronous"},
        }
    metadata, arrays = dataset(root)
    coverage = metadata["coverage"]
    spacing = float(metadata["candidate_spacing_m"])
    extent = coverage["extent_m"]
    kind = coverage["type"]
    if kind not in ("projected_square", "polar_cap", "polar_cap_tile"):
        raise ValueError("No supported scientific coverage geometry is declared")
    radius = 2 * RADIUS * np.tan(np.deg2rad(3) / 2)
    geometry = {
        "type": "cap"
        if kind == "polar_cap"
        else "cap_tile"
        if kind == "polar_cap_tile"
        else "rectangle",
        "extent_m": extent,
        "radius_m": float(radius),
    }
    # Missing grid locations are scientific exclusions, not holes inferred from a display mesh.
    x, y = np.meshgrid(
        np.arange(extent[0], extent[2] + 0.1, spacing),
        np.arange(extent[1], extent[3] + 0.1, spacing),
    )
    expected = np.ones(x.shape, dtype=bool)
    if kind in ("polar_cap", "polar_cap_tile"):
        expected &= np.hypot(x, y) <= radius
    if kind == "polar_cap_tile":
        expected &= (x < extent[2]) & (y < extent[3])
    present = set(zip(arrays["x_m"].tolist(), arrays["y_m"].tolist(), strict=True))
    excluded = [
        {
            "x_m": float(a),
            "y_m": float(b),
            "reason": "Exact pole excluded" if a == 0 and b == 0 else "Scientific data unavailable",
            "radius_m": 0 if a == 0 and b == 0 else spacing / np.sqrt(2),
        }
        for a, b in zip(x[expected], y[expected], strict=True)
        if (a, b) not in present
    ]
    return {
        "dataset_version": metadata["dataset_version"],
        "verified": True,
        "label": coverage["description"],
        "geometry": geometry,
        "excluded_locations": excluded,
        "candidate_count": len(arrays["lat_deg"]),
        "candidate_spacing_m": spacing,
        "layers": {
            "psr_distance": "distance_psr_km" in arrays,
            "approved_features": (root / "features.json").exists(),
        },
        "public_limits": public_limits(),
        "search_service": {"mode": "synchronous"},
    }


def catalog():
    from app.services.hemisphere_survey import ready as survey_ready
    from app.services.hemisphere_terrain import ready

    if is_tiled(settings.data_root):
        metadata = release_metadata(settings.data_root)
        result = catalog_for(settings.data_root, metadata["catalog_sha256"])
    else:
        metadata, _ = dataset(settings.data_root)
        result = catalog_for(settings.data_root, json.dumps(metadata, sort_keys=True))
    detailed_ready = ready()
    return {**result, "hemisphere_detailed": detailed_ready, "hemisphere_survey": detailed_ready and survey_ready()}


@router.get("")
def get_catalog():
    try:
        return catalog()
    except (OSError, ValueError, KeyError) as exc:
        raise HTTPException(
            503, "Verified coverage is unavailable. Retry when the service is ready."
        ) from exc


@router.post("/preview")
def preview(region: RegionSelection):
    try:
        coverage = catalog()
        if region.selector_type == SelectorType.southern_hemisphere:
            from app.services.hemisphere_survey import VERSION, grid

            if not coverage["hemisphere_survey"]:
                raise HTTPException(503, "The whole-hemisphere survey is not prepared yet.")
            return {"status":"inside","candidate_count":len(grid()[0]),
                    "region":region.model_dump(mode="json"),"dataset_version":VERSION,
                    "message":"Ranks a regional sample across the whole southern hemisphere, approximately 150 km apart. "
                              "Slope and roughness use 118 m LOLA terrain; survey horizons use the 1.9 km global grid. Refine shortlisted areas with a 5 km local search."}
        if region.selector_type == SelectorType.feature_radius:
            feature = next(
                (
                    f
                    for f in feature_catalog(settings.data_root)["features"]
                    if f["id"] == region.resolved_feature_id
                ),
                None,
            )
            if feature is None:
                raise HTTPException(422, "Choose an available approved landmark.")
            region.center = Coordinate(
                latitude_deg=feature["latitude_deg"],
                longitude_deg_east=feature["longitude_deg_east"],
            )
            region.input_text = feature["name"]
        if region.selector_type == SelectorType.polygon:
            raise HTTPException(422, "Use a circle or the prepared region.")
        request = SearchRequest(
            region=region,
            time_range=TimeRange(
                start_utc=datetime(2028, 10, 1, tzinfo=UTC),
                end_utc=datetime(2028, 10, 2, tzinfo=UTC),
            ),
        )
        if region.center and region.center.latitude_deg > -87 and coverage["hemisphere_detailed"]:
            from app.services.hemisphere_terrain import VERSION, lattice

            if not coverage["hemisphere_detailed"]:
                raise HTTPException(503, "Hemisphere LOLA terrain is still being installed or could not be verified.")
            if region.center.latitude_deg > 0 or region.search_radius_km > 5:
                raise HTTPException(422, "Choose a southern circle with radius at most 5 km.")
            count = len(lattice(region)[0])
            crossing = region.center.latitude_deg + np.rad2deg(region.search_radius_km*1000/RADIUS) > 0
            return {"status": "partial" if crossing else "inside", "candidate_count": count,
                    "region": region.model_dump(mode="json"), "dataset_version": VERSION,
                    "message": "Southern terrain candidates are generated from verified LOLA elevations. "
                               "Only the southern intersection is ranked for circles crossing the equator."}
        if is_tiled(settings.data_root):
            count = (
                coverage["candidate_count"]
                if region.selector_type == SelectorType.full_supported_region
                else len(load_area(settings.data_root, region)[1]["ids"])
            )
        else:
            _, arrays = dataset(settings.data_root)
            count = int(region_mask(request, arrays).sum())
        if region.center and region.center.latitude_deg > -87 and coverage["hemisphere_detailed"]:
            count = 0
        status = "inside"
        if not count:
            status = "outside"
        elif region.selector_type != SelectorType.full_supported_region:
            center = region.center
            lat, lon = np.deg2rad([center.latitude_deg, center.longitude_deg_east])
            rho = 2 * RADIUS * np.tan(np.pi / 4 + lat / 2)
            cx, cy = rho * np.sin(lon), rho * np.cos(lon)
            radius = region.search_radius_km * 1000
            geometry = coverage["geometry"]
            if geometry["type"] in ("cap", "cap_tile"):
                angular_radius = np.rad2deg(radius / RADIUS)
                if center.latitude_deg + angular_radius > -87:
                    status = "partial"
            if geometry["type"] != "cap":
                # Conservative projection envelope, including polar scale distortion.
                radius *= 1.001
                left, bottom, right, top = geometry["extent_m"]
                if (
                    cx - radius < left
                    or cx + radius > right
                    or cy - radius < bottom
                    or cy + radius > top
                ):
                    status = "partial"
            if any(
                np.hypot(cx - hole["x_m"], cy - hole["y_m"]) <= radius + hole["radius_m"]
                for hole in coverage["excluded_locations"]
            ):
                status = "partial"
        return {
            "status": status,
            "candidate_count": count,
            "region": region.model_dump(mode="json"),
            "dataset_version": coverage["dataset_version"],
            "message": {
                "inside": "Prepared candidate locations are available in this area.",
                "partial": "Only the supported intersection will be analyzed; excluded locations have no results.",
                "outside": "Choose a center within 87–90°S that overlaps prepared candidate locations.",
            }[status],
        }
    except HTTPException:
        raise
    except (OSError, ValueError, KeyError) as exc:
        raise HTTPException(503, "Scientific coverage cannot be verified. Please retry.") from exc
