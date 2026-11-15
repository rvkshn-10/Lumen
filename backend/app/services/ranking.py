"""Column-wise ranking with the scalar operation order and float64 precision."""

import sys

import numpy as np


def score_columns(arrays, indices, metrics, duration, anchors):
    def utility(key, higher=False):
        low, high = anchors[key]
        if high <= low:
            return np.full(len(indices), 0.5)
        values = np.asarray(arrays[key][indices], dtype=np.float64)
        normalized = np.clip((values - low) / (high - low), 0.0, 1.0)
        return normalized if higher else 1 - normalized

    safety = (
        0.45 * utility("slope_deg")
        + 0.35 * utility("roughness_m")
        + 0.20 * utility("elevation_m", True)
    )
    scores = {
        "illumination": 0.5 * metrics["illumination_fraction"]
        + 0.25 * metrics["longest_sunlight_hours"] / duration
        + 0.25 * (1 - metrics["longest_darkness_hours"] / duration),
        "earth_visibility": 0.5 * metrics["earth_visibility_fraction"]
        + 0.25 * metrics["longest_communication_hours"] / duration
        + 0.25 * (1 - metrics["longest_blackout_hours"] / duration),
        "terrain_safety": safety,
        "science_proximity": None,
    }
    psr = (
        np.clip(1 - np.asarray(arrays["distance_psr_km"][indices], dtype=np.float64) / 10, 0, 1)
        if "distance_psr_km" in arrays
        else None
    )
    feature = (
        np.clip(
            1 - np.asarray(arrays["distance_science_feature_km"][indices], dtype=np.float64) / 50,
            0,
            1,
        )
        if "distance_science_feature_km" in arrays
        else None
    )
    scores["science_proximity"] = (
        0.6 * psr + 0.4 * feature
        if psr is not None and feature is not None
        else psr
        if psr is not None
        else feature
    )
    return scores


def rank_columns(request, arrays, indices, rows, weights, duration, anchors):
    from app.services.search import METRIC_KEYS

    if hasattr(rows, "columns"):
        metrics = rows.columns
    else:
        metrics = {
            key: np.fromiter((row[key] for row in rows), dtype=np.float64, count=len(rows))
            for key in METRIC_KEYS
        }
    c = request.hard_constraints
    eligible = np.ones(len(indices), dtype=bool)
    checks = [
        ("illumination_fraction", c.minimum_illumination_fraction, True),
        ("earth_visibility_fraction", c.minimum_earth_visibility_fraction, True),
        ("longest_sunlight_hours", c.minimum_continuous_sunlight_hours, True),
        ("longest_darkness_hours", c.maximum_continuous_darkness_hours, False),
        ("longest_communication_hours", c.minimum_continuous_communication_hours, True),
        ("longest_blackout_hours", c.maximum_continuous_blackout_hours, False),
    ]
    for key, limit, minimum in checks:
        if limit is not None:
            eligible &= metrics[key] >= limit if minimum else metrics[key] <= limit
    columns = score_columns(arrays, indices, metrics, duration, anchors)
    # Python 3.12's sum uses compensated floating-point summation. Preserve it
    # exactly; a NumPy reduction or sequential += can differ by one ULP.
    products = [
        weights[key] * values if values is not None else np.zeros(len(indices))
        for key, values in columns.items()
    ]
    if sys.implementation.name == "cpython" and sys.version_info[:2] == (3, 12):
        # Vectorized finite-float Neumaier sum, matching CPython 3.12's builtin sum.
        # https://github.com/python/cpython/blob/3.12/Python/bltinmodule.c
        total = products[0].copy()
        compensation = np.zeros(len(indices), dtype=np.float64)
        for values in products[1:]:
            next_total = total + values
            compensation += np.where(
                np.abs(total) >= np.abs(values),
                (total - next_total) + values,
                (values - next_total) + total,
            )
            total = next_total
        total = np.where(compensation != 0, total + compensation, total) * 100
    else:
        total = np.fromiter(
            (100 * sum(map(float, row)) for row in zip(*products)),
            dtype=np.float64,
            count=len(indices),
        )
    # Keep a position into columns until map sampling has removed unused rows.
    ranked = [
        (float(total[j]), str(arrays["ids"][indices[j]]), int(indices[j]), int(j), int(j))
        for j in np.flatnonzero(eligible)
    ]

    def materialize(row):
        score, site_id, i, j, metrics_position = row
        scores = {
            key: float(values[j]) if values is not None else None for key, values in columns.items()
        }
        return score, site_id, i, scores, rows[metrics_position]

    return ranked, materialize
