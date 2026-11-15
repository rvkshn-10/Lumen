"""Verified LOLA terrain, 500 m local candidates and terrain-aware horizons."""

import hashlib
import json
import os
from functools import lru_cache
from pathlib import Path

import numpy as np

from app.services.dataset import DataUnavailable
from app.services.terrain_store import digest
from app.settings import REPOSITORY_ROOT

ROOT = Path(os.getenv("LUMEN_HEMISPHERE_ROOT", REPOSITORY_ROOT / "data/raw/hemisphere-lola"))
PPD, COLS, RADIUS = 256, 46080, 1737400.0
VERSION = "hemisphere-lola-256-v1"


@lru_cache(maxsize=2)
def _verified(root, stamps):
    del stamps
    metadata = json.loads((root / "manifest.json").read_text())
    if metadata["version"] != VERSION or metadata["reference_radius_m"] != RADIUS:
        raise DataUnavailable("Unsupported hemisphere terrain manifest")
    arrays = {}
    for name, rows in [
        ("south-000", 23040),
        ("south-180", 23040),
        ("north-000", 1920),
        ("north-180", 1920),
    ]:
        item = metadata["files"][name]
        path = root / item["file"]
        if not path.resolve().is_relative_to(root.resolve()):
            raise DataUnavailable("Invalid hemisphere terrain path")
        if path.stat().st_size != rows * COLS * 4 or digest(path) != item["sha256"]:
            raise DataUnavailable("Hemisphere terrain integrity failed")
        arrays[name] = np.memmap(path, dtype="<f4", mode="r", shape=(rows, COLS))
    return metadata, arrays


def source():
    try:
        names = [ROOT / "manifest.json"]
        metadata = json.loads(names[0].read_text())
        names.extend(ROOT / item["file"] for item in metadata["files"].values())
        stamps = tuple(
            (p.stat().st_size, p.stat().st_mtime_ns, p.stat().st_ctime_ns) for p in names
        )
        return _verified(ROOT, stamps)
    except (OSError, ValueError, KeyError) as exc:
        raise DataUnavailable(
            "Install verified hemisphere LOLA terrain before searching this area."
        ) from exc


def ready():
    # Readiness uses the same integrity verification as calculations.
    try:
        source()
        return True
    except DataUnavailable:
        return False


def sample(grids, latitude, longitude):
    lat, lon = np.broadcast_arrays(np.asarray(latitude), np.asarray(longitude))
    if (
        not np.isfinite(lat).all()
        or not np.isfinite(lon).all()
        or (lat < -90).any()
        or (lat > 7).any()
    ):
        raise DataUnavailable("Horizon ray exceeds the verified terrain buffer")
    row = np.clip((90 - lat) * PPD - 0.5, 21120, 46079)
    col = (lon % 360 * PPD - 0.5) % (2 * COLS)
    r0, c0 = np.floor(row).astype(int), np.floor(col).astype(int)
    dr, dc = row - r0, col - c0

    def gather(r, c):
        output = np.empty(r.shape, dtype=float)
        for north in (False, True):
            for west in (0, 180):
                mask = (r < 23040 if north else r >= 23040) & (c < COLS if west == 0 else c >= COLS)
                name = f"{'north' if north else 'south'}-{west:03d}"
                output[mask] = grids[name][r[mask] - (21120 if north else 23040), c[mask] % COLS]
        return output * 1000

    r1, c1 = np.minimum(r0 + 1, 46079), (c0 + 1) % (2 * COLS)
    values = (1 - dr) * ((1 - dc) * gather(r0, c0) + dc * gather(r0, c1)) + dr * (
        (1 - dc) * gather(r1, c0) + dc * gather(r1, c1)
    )
    if not np.isfinite(values).all() or (np.abs(values) > 15000).any():
        raise DataUnavailable("Unknown or invalid LOLA terrain heights")
    return values


def destination(lat, lon, bearing, distance):
    lat, lon = np.deg2rad(lat), np.deg2rad(lon)
    angle = np.asarray(distance) / RADIUS
    outlat = np.arcsin(
        np.clip(np.sin(lat) * np.cos(angle) + np.cos(lat) * np.sin(angle) * np.cos(bearing), -1, 1)
    )
    outlon = lon + np.arctan2(
        np.sin(bearing) * np.sin(angle) * np.cos(lat), np.cos(angle) - np.sin(lat) * np.sin(outlat)
    )
    return np.rad2deg(outlat), (np.rad2deg(outlon) + 180) % 360 - 180


def lattice(region):
    radius = region.search_radius_km * 1000
    axis = np.arange(-np.floor(radius / 500) * 500, radius + 1, 500)
    x, y = np.meshgrid(axis, axis)
    keep = x * x + y * y <= radius * radius
    x, y = x[keep], y[keep]
    lat, lon = destination(
        region.center.latitude_deg,
        region.center.longitude_deg_east,
        np.arctan2(x, y),
        np.hypot(x, y),
    )
    lat = np.where(np.abs(lat)<1e-12,0.0,lat)
    keep = (lat <= 0) & (lat > -90)
    return x[keep], y[keep], lat[keep], lon[keep]


def derive(grids, lat, lon):
    height = sample(grids, lat, lon)
    offsets = np.array([(x, y) for y in (-250, 0, 250) for x in (-250, 0, 250)])
    dlat, dlon = destination(
        lat[:, None],
        lon[:, None],
        np.arctan2(offsets[:, 0], offsets[:, 1]),
        np.hypot(offsets[:, 0], offsets[:, 1]),
    )
    z = sample(grids, dlat, dlon)
    east = (z[:, 5] - z[:, 3]) / 500
    north = (z[:, 7] - z[:, 1]) / 500
    slope = np.rad2deg(np.arctan(np.hypot(east, north)))
    # Least-squares plane residual, fixed 500 m footprint; units are metres.
    design = np.column_stack((offsets, np.ones(9)))
    fit = z @ np.linalg.pinv(design).T @ design.T
    roughness = np.sqrt(np.mean((z - fit) ** 2, axis=1))
    distances = np.r_[np.arange(118, 20000, 118), np.arange(20000, 200000, 472), 200000]
    azimuth = np.deg2rad(np.arange(0, 360, 5))[None, :, None]
    angle = distances / RADIUS
    profiles, blockers = [], []
    for start in range(0, len(lat), 8):
        stop = min(start + 8, len(lat))
        raylat, raylon = destination(
            lat[start:stop, None, None], lon[start:stop, None, None], azimuth, distances
        )
        terrain = sample(grids, raylat, raylon)
        elevations = np.rad2deg(
            np.arctan2(
                (RADIUS + terrain) * np.cos(angle) - (RADIUS + height[start:stop, None, None] + 2),
                (RADIUS + terrain) * np.sin(angle),
            )
        )
        j = np.argmax(elevations, axis=2)
        profiles.append(np.take_along_axis(elevations, j[:, :, None], axis=2)[:, :, 0])
        blockers.append(distances[j])
    return height, slope, roughness, np.concatenate(profiles), np.concatenate(blockers)


def prepare(region):
    if region.selector_type == "southern_hemisphere":
        from app.services.hemisphere_survey import load

        return load()
    metadata, _ = source()
    fingerprint = hashlib.sha256(json.dumps(metadata, sort_keys=True).encode()).hexdigest()
    return _prepare(region.model_dump_json(), fingerprint)


@lru_cache(maxsize=4)
def _prepare(region_json, fingerprint):
    from app.models import RegionSelection

    del fingerprint
    region = RegionSelection.model_validate_json(region_json)
    metadata, grids = source()
    x, y, lat, lon = lattice(region)
    if not len(lat):
        raise DataUnavailable("No southern candidate locations intersect this circle")
    identity = {"version": VERSION, "source": metadata, "region": region.model_dump(mode="json")}
    key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    height, slope, roughness, profiles, blockers = derive(grids, lat, lon)
    arrays = {
        "ids": np.array([f"hemi-{key[:16]}-{i}" for i in range(len(lat))]),
        "x_m": x,
        "y_m": y,
        "lat_deg": lat,
        "lon_deg": lon,
        "elevation_m": height,
        "slope_deg": slope,
        "roughness_m": roughness,
        "horizons_deg": profiles,
        "blocker_distance_m": blockers,
        "horizon_azimuth_deg": np.arange(0, 360, 5),
    }
    radius = region.search_radius_km * 1000
    mx, my = np.meshgrid(np.linspace(-radius, radius, 41), np.linspace(radius, -radius, 41))
    mlat, mlon = destination(
        region.center.latitude_deg,
        region.center.longitude_deg_east,
        np.arctan2(mx, my),
        np.hypot(mx, my),
    )
    mesh = {
        "width": 41,
        "height": 41,
        "extent_m": [-radius, -radius, radius, radius],
        "elevations_m": sample(grids, mlat, mlon).ravel().tolist(),
        "resolution_m": 2 * radius / 40,
        "source_resolution_m": 118.4505876,
        "row_order": "north_to_south",
        "source": "NASA PDS LOLA LDEM 256 ppd",
        "crs": "Local azimuthal equidistant, east/north metres about selected center",
    }
    return {
        "dataset_version": VERSION,
        "coordinate_frame": "MOON_ME_DE440_ME421",
        "reference_radius_m": RADIUS,
        "candidate_count": len(lat),
        "candidate_spacing_m": 500,
        "coverage": {
            "description": "Selected southern hemisphere circle using LOLA 256 ppd terrain"
        },
        "artifacts": {
            "source_manifest_sha256": hashlib.sha256(
                json.dumps(metadata, sort_keys=True).encode()
            ).hexdigest()
        },
        "scoring_reference": {
            "id": "hemisphere-terrain-fixed-v1",
            "method": "fixed hemisphere terrain bounds; clipped linear utility",
            "bounds": {"slope_deg": [0, 30], "roughness_m": [0, 100], "elevation_m": [-9000, 9000]},
        },
        "display_terrain": mesh,
        "terrain_metrics": {
            "slope": "Central differences over 500 m",
            "roughness": "RMS residual to a plane on a 3x3 grid over 500 m",
        },
        "source": metadata,
        "horizon_azimuth_step_deg": 5,
        "horizon_maximum_range_m": 200000,
    }, arrays
