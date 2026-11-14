"""Versioned, fixed four-class score display; not a landing-safety classifier."""

import numpy as np

LEGEND = {"bins": [0.0, 0.25, 0.5, 0.75, 1.0],
          "labels": ["poor", "fair", "good", "excellent"]}


def suitability_class(score):
    values = np.asarray(score, dtype=float) / 100
    return np.where(np.isfinite(values), np.clip(np.digitize(values, LEGEND["bins"]) - 1, 0, 3), -1)
