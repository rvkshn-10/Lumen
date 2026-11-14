"""Ideal direct-solar electrical estimates; independent of the verification reference."""

from __future__ import annotations

from datetime import datetime, timedelta
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


def _battery_trace(power, hours, *, load_w, capacity_wh, start_soc):
    reserve = capacity_wh * start_soc
    trace = [reserve]
    for generated, duration in zip(power[:-1], hours, strict=True):
        reserve = min(capacity_wh, reserve + (generated - load_w) * duration)
        trace.append(reserve)
    return trace


def _battery_summary(trace):
    depleted = next((index for index, reserve in enumerate(trace[1:]) if reserve <= 0), None)
    return {"min_soc_wh": float(min(trace)), "depleted_index": depleted}


def battery_survival(power, hours, *, load_w, capacity_wh, start_soc=1.0):
    return _battery_summary(
        _battery_trace(power, hours, load_w=load_w, capacity_wh=capacity_wh, start_soc=start_soc)
    )


def _first_outage(times, trace):
    for (start, end), (previous, next_reserve) in zip(pairwise(times), pairwise(trace),
                                                     strict=True):
        # An empty battery can support the load with direct solar. Once reserve crosses
        # zero under a deficit, the model assumes no restart or later recovery.
        if next_reserve <= 0 and (previous > 0 or next_reserve < 0):
            return start + (end - start) * (previous / (previous - next_reserve))
    return None


def _contact_intervals(times, dte_states, until=None):
    windows = []
    for index, (start, end) in enumerate(pairwise(times)):
        if until is not None and start >= until:
            break
        if not dte_states[index]:
            continue
        usable_end = min(end, until) if until is not None else end
        if windows and windows[-1][1] == start:
            windows[-1] = (windows[-1][0], usable_end)
        else:
            windows.append((start, usable_end))
    return [
        {"start_utc": start.isoformat(), "end_utc": end.isoformat(),
         "duration_hours": (end - start) / timedelta(hours=1)}
        for start, end in windows
    ]


def _powered_contact(times, trace, dte_states, display_indices):
    """Intersect DTE geometry with continuous operation before first battery outage."""
    outage = _first_outage(times, trace)
    intervals = _contact_intervals(times, dte_states, outage)
    reserve_series = [
        {"time_utc": times[index].isoformat(), "reserve_wh": float(trace[index])}
        for index in display_indices if outage is None or times[index] < outage
    ]
    if outage is not None:
        reserve_series.append({"time_utc": outage.isoformat(), "reserve_wh": 0})
    return {
        "windows": intervals,
        "dte_windows": _contact_intervals(times, dte_states),
        "longest_contact_hours": max((item["duration_hours"] for item in intervals), default=0.0),
        "first_depletion_utc": outage.isoformat() if outage is not None else None,
        "min_reserve_wh": 0.0 if outage is not None else float(min(trace)),
        "reserve_series": reserve_series,
    }


def power_estimate(timeline: list[dict], settings: PowerSettings | None = None, *, dte_states=None):
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
    trace = _battery_trace(vertical, hours, load_w=settings.load_w,
                           capacity_wh=settings.capacity_wh, start_soc=settings.start_soc)
    result = {
        "assumptions": {"area_m2": settings.area_m2, "efficiency": settings.efficiency,
                        "mount": "vertical_tracking", "solar_constant_w_m2": SOLAR_CONSTANT_W_M2,
                        "integration": "left sample, duration weighted, mission-end clipped",
                        "excludes": ["temperature", "dust", "degradation", "conversion losses",
                                     "terrain-reflected light", "battery efficiency"]},
        "series": [{"time_utc": timeline[j]["time_utc"], "vertical_w": float(vertical[j]),
                    "horizontal_w": float(horizontal[j])} for j in indices],
        "energy_wh": energy_wh(vertical, hours),
        "horizontal_energy_wh": energy_wh(horizontal, hours),
        "battery": {**_battery_summary(trace),
                    "load_w": settings.load_w, "capacity_wh": settings.capacity_wh,
                    "start_soc": settings.start_soc},
    }
    if dte_states is not None:
        result["powered_contact"] = _powered_contact(times, trace, dte_states, indices)
    return result
