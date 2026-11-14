"""Ideal direct-solar electrical estimates; independent of the verification reference."""

from __future__ import annotations

from datetime import datetime
from itertools import pairwise

import numpy as np

from app.models import PowerSettings

AU_KM = 149_597_870.7
SOLAR_CONSTANT_W_M2 = 1361.0


def power_w(sun_el_deg, sun_dist_km, disk_fraction, *, area_m2=1.0,
            efficiency=0.30, mount="vertical_tracking"):
    if mount not in ("vertical_tracking", "horizontal"):
        raise ValueError("Unknown solar-array mount")
    elevation = np.deg2rad(np.asarray(sun_el_deg))
    incidence = np.cos(elevation) if mount == "vertical_tracking" else np.sin(elevation)
    flux = SOLAR_CONSTANT_W_M2 * (AU_KM / np.asarray(sun_dist_km)) ** 2
    return np.maximum(0, flux * area_m2 * efficiency * np.clip(incidence, 0, 1)
                      * np.asarray(disk_fraction))


def energy_wh(power, hours):
    return float(np.sum(np.asarray(power)[:-1] * hours))


def battery_survival(power, hours, *, load_w, capacity_wh, start_soc=1.0):
    soc = capacity_wh * start_soc
    minimum, depleted = soc, None
    for index, duration in enumerate(hours):
        soc = min(capacity_wh, soc + (power[index] - load_w) * duration)
        if soc <= 0 and depleted is None:
            depleted = index
        minimum = min(minimum, soc)
    return {"min_soc_wh": float(minimum), "depleted_index": depleted}


def power_estimate(timeline: list[dict], settings: PowerSettings | None = None):
    settings = settings or PowerSettings()
    times = [datetime.fromisoformat(row["time_utc"]) for row in timeline]
    hours = np.array([(b - a).total_seconds() / 3600 for a, b in pairwise(times)])
    arguments = ([row["sun_elevation_deg"] for row in timeline],
                 [row["sun_distance_km"] for row in timeline],
                 [row["solar_fraction"] for row in timeline])
    vertical = power_w(*arguments, area_m2=settings.area_m2, efficiency=settings.efficiency)
    horizontal = power_w(*arguments, area_m2=settings.area_m2,
                         efficiency=settings.efficiency, mount="horizontal")
    # Display at hourly samples plus the exact end; integrate the full five-minute grid.
    indices = [0]
    for index in range(1, len(times) - 1):
        if (times[index] - times[indices[-1]]).total_seconds() >= 3600:
            indices.append(index)
    if indices[-1] != len(times) - 1:
        indices.append(len(times) - 1)
    return {
        "assumptions": {"area_m2": settings.area_m2, "efficiency": settings.efficiency,
                        "mount": "vertical_tracking", "solar_constant_w_m2": SOLAR_CONSTANT_W_M2,
                        "integration": "left sample, duration weighted, mission-end clipped",
                        "excludes": ["temperature", "dust", "degradation", "conversion losses",
                                     "terrain-reflected light", "battery efficiency"]},
        "series": [{"time_utc": timeline[j]["time_utc"], "vertical_w": float(vertical[j]),
                    "horizontal_w": float(horizontal[j])} for j in indices],
        "energy_wh": energy_wh(vertical, hours),
        "horizontal_energy_wh": energy_wh(horizontal, hours),
        "battery": {**battery_survival(vertical, hours, load_w=settings.load_w,
                                       capacity_wh=settings.capacity_wh,
                                       start_soc=settings.start_soc),
                    "load_w": settings.load_w, "capacity_wh": settings.capacity_wh,
                    "start_soc": settings.start_soc},
    }
