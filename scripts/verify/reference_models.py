"""Reference implementations for Lumen's derived quantities.

These are the *specification* the app must reproduce. They are deliberately
small, numpy-only and independent of backend/app so the verifier never checks
the app against itself. If the app and this file disagree, one of them is wrong:
fix the app, or change this file in a reviewed PR that also updates
docs/verification.md.
"""
from __future__ import annotations

from itertools import pairwise

import numpy as np

AU_KM = 149_597_870.7
SOLAR_CONSTANT_W_M2 = 1361.0
SUN_RADIUS_KM = 695_700.0

# ---------------------------------------------------------------- visibility


def horizon_at(profile: np.ndarray, azimuth_deg: np.ndarray) -> np.ndarray:
    """Conservative adjacent-bin maximum, periodic across north."""
    n = profile.shape[-1]
    bins = (np.asarray(azimuth_deg) % 360) * n / 360
    lo = np.floor(bins).astype(int) % n
    return np.maximum(profile[..., lo], profile[..., (lo + 1) % n])


def solar_disk_fraction(clearance_deg, radius_deg):
    x = np.clip(np.asarray(clearance_deg) / radius_deg, -1, 1)
    return (np.arccos(-x) + x * np.sqrt(np.maximum(0, 1 - x * x))) / np.pi


def hours_between(times) -> np.ndarray:
    return np.array([(b - a).total_seconds() / 3600 for a, b in pairwise(times)])


def run_metrics(states: np.ndarray, hours: np.ndarray) -> tuple[float, float, float]:
    """Fraction, longest visible run, longest blocked run (left-sample rule)."""
    s = np.asarray(states, bool)[:-1]
    frac = float(np.sum(hours * s) / hours.sum())
    best = {True: 0.0, False: 0.0}
    run, prev = 0.0, None
    for state, h in zip(s, hours, strict=True):
        run = run + h if state == prev else h
        best[bool(state)] = max(best[bool(state)], run)
        prev = state
    return frac, best[True], best[False]


def visibility_metrics(sun_el, sun_h, sun_dist_km, earth_el, earth_h, hours) -> dict:
    radius = np.rad2deg(np.arcsin(SUN_RADIUS_KM / np.asarray(sun_dist_km)))
    sun_vis = sun_el + radius > sun_h
    earth_vis = earth_el > earth_h
    sf = solar_disk_fraction(sun_el - sun_h, radius)
    i, sl, dl = run_metrics(sun_vis, hours)
    e, cl, bl = run_metrics(earth_vis, hours)
    return {
        "illumination_fraction": i,
        "earth_visibility_fraction": e,
        "longest_sunlight_hours": sl,
        "longest_darkness_hours": dl,
        "longest_communication_hours": cl,
        "longest_blackout_hours": bl,
        "mean_visible_solar_disk_fraction": float(np.sum(sf[:-1] * hours) / hours.sum()),
        "_sun_visible": sun_vis,
        "_earth_visible": earth_vis,
        "_solar_fraction": sf,
    }


# ------------------------------------------------------------------- scoring


def category_scores(metrics: dict, slope, roughness, elevation, duration_h, anchors) -> dict:
    def util(v, key, higher=False):
        lo, hi = anchors[key]
        if hi <= lo:
            return 0.5
        n = min(1.0, max(0.0, (v - lo) / (hi - lo)))
        return n if higher else 1 - n

    m = metrics
    return {
        "illumination": 0.5 * m["illumination_fraction"]
        + 0.25 * m["longest_sunlight_hours"] / duration_h
        + 0.25 * (1 - m["longest_darkness_hours"] / duration_h),
        "earth_visibility": 0.5 * m["earth_visibility_fraction"]
        + 0.25 * m["longest_communication_hours"] / duration_h
        + 0.25 * (1 - m["longest_blackout_hours"] / duration_h),
        "terrain_safety": 0.45 * util(slope, "slope_deg")
        + 0.35 * util(roughness, "roughness_m")
        + 0.20 * util(elevation, "elevation_m", True),
    }


def total_score(criteria: dict, weights: dict) -> float:
    return 100 * sum(weights.get(k, 0) * (criteria.get(k) or 0) for k in weights)


# --------------------------------------------------------------------- power
# Decision (see docs/verification.md): Lumen reports power for a *vertical,
# azimuth-tracking* array (the configuration used by polar landers, because the
# Sun skims the horizon) and, for contrast, a horizontal fixed array.
# P = S0 * (1 AU / r)^2 * area * efficiency * incidence * visible_disk_fraction


def power_w(sun_el_deg, sun_dist_km, disk_fraction, *, area_m2=1.0, efficiency=0.30,
            mount="vertical_tracking"):
    el = np.deg2rad(np.asarray(sun_el_deg))
    if mount == "vertical_tracking":
        incidence = np.cos(el)
    elif mount == "horizontal":
        incidence = np.sin(el)
    else:
        raise ValueError(mount)
    flux = SOLAR_CONSTANT_W_M2 * (AU_KM / np.asarray(sun_dist_km)) ** 2
    return np.maximum(0.0, flux * area_m2 * efficiency * np.clip(incidence, 0, 1)
                      * np.asarray(disk_fraction))


def energy_wh(power: np.ndarray, hours: np.ndarray) -> float:
    return float(np.sum(power[:-1] * hours))


def battery_survival(power, hours, *, load_w, capacity_wh, start_soc=1.0) -> dict:
    """Simple bucket battery: returns min state of charge and first depletion index."""
    soc = capacity_wh * start_soc
    min_soc, depleted_at = soc, None
    for j, h in enumerate(hours):
        soc = min(capacity_wh, soc + (power[j] - load_w) * h)
        if soc <= 0 and depleted_at is None:
            depleted_at = j
        min_soc = min(min_soc, soc)
    return {"min_soc_wh": float(min_soc), "depleted_index": depleted_at}


# -------------------------------------------------------------------- events


def transitions(states, times, kind_on: str, kind_off: str) -> list[dict]:
    """Rise/set events bracketed by adjacent samples (sample-resolution)."""
    out = []
    s = np.asarray(states, bool)
    for j in np.flatnonzero(s[1:] != s[:-1]):
        out.append({"type": kind_on if s[j + 1] else kind_off,
                    "after": times[j], "before": times[j + 1]})
    return out


def next_set(states, times, kind: str):
    """First time the body is lost (sunset/earthset) after the window start."""
    for e in transitions(states, times, f"{kind}rise", f"{kind}set"):
        if e["type"] == f"{kind}set":
            return e
    return None


# ---------------------------------------------------------------- suitability


SUITABILITY_BINS = (0.0, 0.25, 0.5, 0.75, 1.0001)
SUITABILITY_LABELS = ("poor", "fair", "good", "excellent")


def suitability_class(score_0_100):
    """Map a 0-100 score to a colour-map class index. NaN -> -1 (unknown)."""
    s = np.asarray(score_0_100, float) / 100
    idx = np.digitize(s, SUITABILITY_BINS) - 1
    return np.where(np.isfinite(s), np.clip(idx, 0, 3), -1)
