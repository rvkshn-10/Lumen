"""Experimental float64 kernel; opt in only while collecting qualification evidence.

The reference in search.analyze_batch remains the default. A block is certified
using a cone containing EVERY ephemeris vector in the block, not endpoint guesses.
Global horizon extrema deliberately overbound the azimuth span. Partial solar
disks always use full samples, preserving the disk-fraction metric too.
"""

import logging
import os
from itertools import pairwise

import numpy as np

try:
    from numba import njit, prange
except (ImportError, OSError):
    njit = None


if njit is not None:

    @njit(cache=True)
    def direction(body, ux, uy, uz, ex, ey, nx, ny, nz, height):
        x, y, z = body[0] - ux * height, body[1] - uy * height, body[2] - uz * height
        distance = np.sqrt(x * x + y * y + z * z)
        elevation = (
            np.arcsin(min(1.0, max(-1.0, (x * ux + y * uy + z * uz) / distance))) * 180 / np.pi
        )
        azimuth = np.arctan2(x * ex + y * ey, x * nx + y * ny + z * nz) * 180 / np.pi % 360
        return distance, elevation, azimuth

    @njit(cache=True, parallel=True)
    def sample_kernel(lat, lon, heights, profiles, bodies, drifts, radius_km, coarse):
        n, nt = len(lat), len(bodies)
        visible = np.empty((n, nt), dtype=np.bool_)
        fractions = np.empty((n, nt), dtype=np.float64)
        near_boundary = np.zeros(n, dtype=np.bool_)
        for i in prange(n):
            la, lo = lat[i] * np.pi / 180, lon[i] * np.pi / 180
            ux, uy, uz = np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)
            ex, ey = -np.sin(lo), np.cos(lo)
            nx, ny, nz = -uz * ey, uz * ex, ux * ey - uy * ex
            height = (1737400 + heights[i] + 2) / 1000
            low, high = np.min(profiles[i]), np.max(profiles[i])
            for block in range(0, nt, 12):
                stop = min(block + 12, nt)
                certified = -1
                if coarse:
                    distance, elevation, _ = direction(
                        bodies[block], ux, uy, uz, ex, ey, nx, ny, nz, height
                    )
                    drift = drifts[block // 12]
                    if distance > drift + radius_km:
                        cone = np.arcsin(min(1.0, drift / distance)) * 180 / np.pi + 1e-9
                        limb = np.arcsin(radius_km / (distance - drift)) * 180 / np.pi
                        if elevation - cone - limb > high:
                            certified = 1
                        elif elevation + cone + limb < low:
                            certified = 0
                for t in range(block, stop):
                    if certified >= 0:
                        visible[i, t] = certified == 1
                        fractions[i, t] = certified
                        continue
                    distance, elevation, azimuth = direction(
                        bodies[t], ux, uy, uz, ex, ey, nx, ny, nz, height
                    )
                    bins = azimuth * profiles.shape[1] / 360
                    j = int(np.floor(bins)) % profiles.shape[1]
                    horizon = max(profiles[i, j], profiles[i, (j + 1) % profiles.shape[1]])
                    limb = np.arcsin(radius_km / distance) * 180 / np.pi
                    clearance = elevation - horizon
                    # Let the NumPy reference decide numerical edge cases.
                    if abs(clearance + limb) < 1e-9 or abs(bins - round(bins)) < 1e-10:
                        near_boundary[i] = True
                    visible[i, t] = elevation + limb > horizon
                    if radius_km:
                        x = min(1.0, max(-1.0, clearance / limb))
                        fractions[i, t] = (np.arccos(-x) + x * np.sqrt(max(0.0, 1 - x * x))) / np.pi
                    else:
                        fractions[i, t] = 1.0 if visible[i, t] else 0.0
        return visible, fractions, near_boundary


def block_drifts(body):
    return np.asarray(
        [
            np.max(np.linalg.norm(body[j : j + 12] - body[j], axis=1))
            for j in range(0, len(body), 12)
        ]
    )


def compiled_samples(arrays, indices, body, radius_km, coarse=True):
    if njit is None:
        raise ImportError("Numba is unavailable")
    return sample_kernel(
        *(
            np.asarray(arrays[k][indices], dtype=np.float64)
            for k in ("lat_deg", "lon_deg", "elevation_m", "horizons_deg")
        ),
        body,
        block_drifts(body),
        radius_km,
        coarse,
    )


def evaluate_batch(arrays, indices, times, sun, earth):
    from app.services.ephemeris import SUN_RADIUS_KM
    from app.services.search import METRIC_KEYS, _longest_runs, analyze_batch

    if os.getenv("LUMEN_TEMPORAL_KERNEL", "reference") != "compiled" or njit is None:
        return analyze_batch(arrays, indices, times, sun, earth)
    try:
        sunlight, disk, edge1 = compiled_samples(arrays, indices, sun, SUN_RADIUS_KM)
        communication, _, edge2 = compiled_samples(arrays, indices, earth, 0.0)
        if np.any(edge1 | edge2):
            return analyze_batch(arrays, indices, times, sun, earth)
        hours = np.array([(b - a).total_seconds() / 3600 for a, b in pairwise(times)])
        sunlong, darklong = _longest_runs(sunlight[:, :-1], hours)
        earthlong, blackout = _longest_runs(communication[:, :-1], hours)
        columns = [
            np.sum(sunlight[:, :-1] * hours, axis=1) / hours.sum(),
            np.sum(communication[:, :-1] * hours, axis=1) / hours.sum(),
            sunlong,
            darklong,
            earthlong,
            blackout,
            np.sum(disk[:, :-1] * hours, axis=1) / hours.sum(),
        ]
        return [dict(zip(METRIC_KEYS, map(float, row), strict=True)) for row in zip(*columns)]
    except Exception:
        logging.getLogger(__name__).warning(
            "Compiled kernel unavailable; using reference", exc_info=True
        )
        return analyze_batch(arrays, indices, times, sun, earth)
