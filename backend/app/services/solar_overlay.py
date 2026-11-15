"""Estimated solar generation across the Moon at one instant, for the 3D overlay.

Both layers use exactly the same panel model as the site power estimate
(``power.power_w``: solar constant scaled to the Sun's distance, a sun-tracking
vertical panel, the visible fraction of the solar disk):

* ``terrain``: the prepared 87°S–90°S cap on a 2 km polar-stereographic grid.
  Each point uses its own NASA LOLA horizon profile, so terrain shadows count.
* ``coarse``: the whole Moon on a 2° latitude/longitude grid on a smooth
  sphere with a flat horizon. No terrain shadows; only day/night geometry.

Sun positions come from NASA/NAIF SPICE (DE440) at the requested time.
"""

from __future__ import annotations

from datetime import datetime
from functools import lru_cache

import numpy as np

from app.models import PowerSettings
from app.services.ephemeris import RADIUS_M, SUN_RADIUS_KM, positions_at_times, solar_disk_fraction
from app.services.power import SOLAR_CONSTANT_W_M2, power_w
from app.services.repository import is_tiled, load_area, load_site
from app.settings import settings

GRID_STEP_M = 2000
CAP_HALF_M = 100_000
COARSE_STEP_DEG = 2


def _frames(lat_deg, lon_deg):
    lat, lon = np.deg2rad(lat_deg), np.deg2rad(lon_deg)
    up = np.stack((np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)), axis=-1)
    east = np.stack((-np.sin(lon), np.cos(lon), np.zeros_like(lon)), axis=-1)
    north = np.cross(up, east)
    return up, east, north


def _sun_geometry(up, east, north, observer_km, sun):
    vectors = sun[None, :] - observer_km
    distance = np.linalg.norm(vectors, axis=1)
    azimuth = np.rad2deg(np.arctan2(np.einsum("ni,ni->n", vectors, east), np.einsum("ni,ni->n", vectors, north))) % 360
    elevation = np.rad2deg(np.arcsin(np.clip(np.einsum("ni,ni->n", vectors, up) / distance, -1, 1)))
    return azimuth, elevation, distance


def terrain_watts(arrays: dict, sun: np.ndarray, power: PowerSettings) -> np.ndarray:
    """Per-site W with the site's LOLA horizon (same geometry as the site timeline)."""
    up, east, north = _frames(arrays["lat_deg"].astype(np.float64), arrays["lon_deg"].astype(np.float64))
    observer = up * ((RADIUS_M + arrays["elevation_m"].astype(np.float64) + 2) / 1000)[:, None]
    azimuth, elevation, distance = _sun_geometry(up, east, north, observer, sun)
    profile = arrays["horizons_deg"]
    bins = profile.shape[1]
    lo = np.floor((azimuth % 360) * bins / 360).astype(int) % bins
    rows = np.arange(len(lo))
    horizon = np.maximum(profile[rows, lo], profile[rows, (lo + 1) % bins])
    radius = np.rad2deg(np.arcsin(SUN_RADIUS_KM / distance))
    fraction = solar_disk_fraction(elevation - horizon, radius)
    return power_w(elevation, distance, fraction, area_m2=power.area_m2, efficiency=power.efficiency)


@lru_cache(maxsize=1)
def _cap_grid(root) -> dict | None:
    """Prepared cap sites that sit on the 2 km grid, with their horizon profiles."""
    if not is_tiled(root):
        return None
    from app.models import RegionSelection

    _, arrays = load_area(root, RegionSelection(selector_type="full_supported_region"))
    x, y = np.rint(arrays["x_m"]).astype(np.int64), np.rint(arrays["y_m"]).astype(np.int64)
    keep = (x % GRID_STEP_M == 0) & (y % GRID_STEP_M == 0)
    keep &= (np.abs(x) <= CAP_HALF_M) & (np.abs(y) <= CAP_HALF_M)
    side = 2 * CAP_HALF_M // GRID_STEP_M + 1
    column = (x[keep] + CAP_HALF_M) // GRID_STEP_M
    row = (CAP_HALF_M - y[keep]) // GRID_STEP_M  # north (+y) to south, like terrain.json
    return {
        "side": int(side),
        "cells": (row * side + column).astype(np.int64),
        "arrays": {key: arrays[key][keep] for key in ("lat_deg", "lon_deg", "elevation_m", "horizons_deg")},
    }


def coarse_watts(sun: np.ndarray, power: PowerSettings):
    latitudes = np.arange(-90, 90 + COARSE_STEP_DEG, COARSE_STEP_DEG, dtype=np.float64)
    longitudes = np.arange(-180, 180 + COARSE_STEP_DEG, COARSE_STEP_DEG, dtype=np.float64)
    lat, lon = np.meshgrid(latitudes, longitudes, indexing="ij")
    up, east, north = _frames(lat.ravel(), lon.ravel())
    _, elevation, distance = _sun_geometry(up, east, north, up * (RADIUS_M / 1000), sun)
    radius = np.rad2deg(np.arcsin(SUN_RADIUS_KM / distance))
    fraction = solar_disk_fraction(elevation, radius)  # flat horizon at 0°
    watts = power_w(elevation, distance, fraction, area_m2=power.area_m2, efficiency=power.efficiency)
    return latitudes, longitudes, watts.reshape(lat.shape)


def overlay(time: datetime, power: PowerSettings, probe_site_id: str | None = None) -> dict:
    sun = positions_at_times(settings.kernel_root, [time])[0][0]
    latitudes, longitudes, coarse = coarse_watts(sun, power)
    result = {
        "time_utc": time.isoformat().replace("+00:00", "Z"),
        "unit": "W",
        "assumptions": {"area_m2": power.area_m2, "efficiency": power.efficiency, "mount": "vertical_tracking",
                        "solar_constant_w_m2": SOLAR_CONSTANT_W_M2,
                        "excludes": ["temperature", "dust", "degradation", "conversion losses", "terrain-reflected light"]},
        "maximum_w": float(SOLAR_CONSTANT_W_M2 * power.area_m2 * power.efficiency * 1.04),
        "coarse": {"model": "Smooth sphere, flat horizon: no terrain shadows", "step_deg": COARSE_STEP_DEG,
                   "latitude_min_deg": -90, "longitude_min_deg": -180,
                   "rows": len(latitudes), "columns": len(longitudes),
                   "watts": np.round(coarse, 2).ravel().tolist()},
        "terrain": None,
    }
    grid = _cap_grid(settings.data_root)
    if grid is not None:
        watts = np.full(grid["side"] * grid["side"], np.nan)
        watts[grid["cells"]] = terrain_watts(grid["arrays"], sun, power)
        result["terrain"] = {
            "model": "NASA LOLA horizons: terrain shadows included",
            "projection": "south polar stereographic, central meridian 0, radius 1737400 m",
            "extent_m": [-CAP_HALF_M, -CAP_HALF_M, CAP_HALF_M, CAP_HALF_M],
            "step_m": GRID_STEP_M, "side": grid["side"], "row_order": "north_to_south",
            "watts": [None if np.isnan(value) else round(float(value), 2) for value in watts],
        }
    if probe_site_id:
        _, arrays = load_site(settings.data_root, probe_site_id)
        from app.services.terrain_store import UnknownSite

        index = np.flatnonzero(arrays["ids"] == probe_site_id)
        if not len(index):
            raise UnknownSite(probe_site_id)
        site = {key: arrays[key][index] for key in ("lat_deg", "lon_deg", "elevation_m", "horizons_deg")}
        result["probe"] = {"site_id": probe_site_id, "watts": float(terrain_watts(site, sun, power)[0])}
    return result
