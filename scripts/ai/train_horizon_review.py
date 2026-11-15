"""Train a tiny visibility surrogate on synthetic horizon clearances."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

MODEL_PATH = (
    Path(__file__).resolve().parents[2] / "backend/app/services/horizon_mlp_v1.json"
)
SEED = 415
SOLAR_RADIUS_DEG = 0.2666


def examples(rng: np.random.Generator, count: int) -> tuple[np.ndarray, np.ndarray]:
    # Include deliberately dense samples close to either visibility transition.
    offsets = rng.uniform(-0.6, 0.6, size=(count, 2))
    offsets[::3] = rng.uniform(-8, 8, size=(len(offsets[::3]), 2))
    limb = rng.uniform(0.257, 0.271, size=count)
    clearance = offsets - [SOLAR_RADIUS_DEG, 0]
    labels = clearance + np.column_stack((limb, np.zeros(count))) > 0
    return np.clip(clearance, -8, 8), labels.astype(float)


def train() -> dict:
    rng = np.random.default_rng(SEED)
    train_x, train_y = examples(rng, 12_288)
    test_x, test_y = examples(np.random.default_rng(SEED + 1), 8_192)
    hidden_weights = rng.normal(0, 0.45, (2, 12))
    hidden_bias = np.zeros(12)
    output_weights = rng.normal(0, 0.45, (12, 2))
    output_bias = np.zeros(2)

    for _ in range(6_000):
        batch = rng.integers(len(train_x), size=256)
        features, truth = train_x[batch], train_y[batch]
        projected = features @ hidden_weights + hidden_bias
        hidden = np.maximum(projected, 0)
        logits = hidden @ output_weights + output_bias
        residual = (1 / (1 + np.exp(-np.clip(logits, -60, 60))) - truth) / len(batch)
        hidden_gradient = (residual @ output_weights.T) * (projected > 0)
        output_weights -= 0.08 * (hidden.T @ residual)
        output_bias -= 0.08 * residual.sum(axis=0)
        hidden_weights -= 0.08 * (features.T @ hidden_gradient)
        hidden_bias -= 0.08 * hidden_gradient.sum(axis=0)

    arrays = {
        "hidden_weights": hidden_weights,
        "hidden_bias": hidden_bias,
        "output_weights": output_weights,
        "output_bias": output_bias,
    }
    weights = {key: value.astype(np.float32).tolist() for key, value in arrays.items()}
    prediction = (
        np.maximum(test_x @ hidden_weights + hidden_bias, 0) @ output_weights
        + output_bias
    ) > 0
    matches = prediction == test_y
    print(f"Held-out synthetic pairs: {len(test_y)}")
    print(
        f"Agreement: Sun {matches[:, 0].mean():.2%}, Earth {matches[:, 1].mean():.2%}"
    )
    print(f"Both: {matches.all(axis=1).mean():.2%}")
    return weights


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=MODEL_PATH)
    args = parser.parse_args()
    args.output.write_text(json.dumps(train(), indent=2) + "\n", encoding="utf-8")
