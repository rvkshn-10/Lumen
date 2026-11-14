"""Experimental CPU inference. The science engine supplies the reference labels."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from time import perf_counter
from typing import Literal

import numpy as np
from pydantic import AwareDatetime, BaseModel, Field

MODEL_NAME = "horizon-mlp-v1"
SOLAR_RADIUS_DEG = 0.2666
NEAR_HORIZON_DEG = 0.1


class HorizonSample(BaseModel):
    time_utc: AwareDatetime
    sun_elevation_deg: float = Field(ge=-90, le=90)
    sun_horizon_deg: float = Field(ge=-90, le=90)
    earth_elevation_deg: float = Field(ge=-90, le=90)
    earth_horizon_deg: float = Field(ge=-90, le=90)
    sun_visible: bool
    earth_visible: bool


class HorizonReview(BaseModel):
    samples: list[HorizonSample] = Field(min_length=1, max_length=2048)


class HorizonResult(BaseModel):
    engine: Literal["OpenVINO"] = "OpenVINO"
    device: Literal["CPU"] = "CPU"
    model: str = MODEL_NAME
    runtime_version: str
    samples: int
    agreement: float
    sun_agreement: float
    earth_agreement: float
    near_horizon_samples: int
    disagreement_indices: list[int]
    inference_ms: float


class RuntimeUnavailable(Exception):
    pass


@lru_cache(maxsize=1)
def compiled_cpu_model():
    try:
        import openvino as ov
        from openvino import opset13 as ops
    except ImportError as exc:
        raise RuntimeUnavailable(
            "Install the optional OpenVINO runtime for CPU inference."
        ) from exc

    try:
        weights = json.loads(Path(__file__).with_name("horizon_mlp_v1.json").read_text())
        constants = {
            key: ops.constant(np.asarray(value, dtype=np.float32)) for key, value in weights.items()
        }
        data = ops.parameter([-1, 2], dtype=np.float32, name="angular_clearance_deg")
        hidden = ops.relu(
            ops.add(
                ops.matmul(data, constants["hidden_weights"], False, False),
                constants["hidden_bias"],
            )
        )
        logits = ops.add(
            ops.matmul(hidden, constants["output_weights"], False, False), constants["output_bias"]
        )
        program = ov.Model([logits], [data], MODEL_NAME)
        compiled = ov.Core().compile_model(program, "CPU", {"INFERENCE_NUM_THREADS": 1})
        return compiled, ov.__version__
    except (RuntimeError, OSError) as exc:
        raise RuntimeUnavailable("OpenVINO could not initialize its CPU runtime.") from exc


def review_horizon(samples: list[HorizonSample]) -> HorizonResult:
    compiled, version = compiled_cpu_model()
    clearance = np.asarray(
        [
            [
                point.sun_elevation_deg - point.sun_horizon_deg,
                point.earth_elevation_deg - point.earth_horizon_deg,
            ]
            for point in samples
        ],
        dtype=np.float32,
    )
    reference = np.asarray([[point.sun_visible, point.earth_visible] for point in samples])
    inputs = np.clip(clearance, -8, 8)
    started = perf_counter()
    try:
        output = compiled.create_infer_request().infer({0: inputs})[0]
    except RuntimeError as exc:
        raise RuntimeUnavailable("OpenVINO could not run the visibility model.") from exc
    elapsed_ms = (perf_counter() - started) * 1_000
    matched = (output > 0) == reference
    paired = matched.all(axis=1)
    near = np.any(np.abs(clearance + [SOLAR_RADIUS_DEG, 0]) <= NEAR_HORIZON_DEG, axis=1)
    return HorizonResult(
        runtime_version=version,
        samples=len(samples),
        agreement=float(paired.mean()),
        sun_agreement=float(matched[:, 0].mean()),
        earth_agreement=float(matched[:, 1].mean()),
        near_horizon_samples=int(near.sum()),
        disagreement_indices=np.flatnonzero(~paired).tolist(),
        inference_ms=elapsed_ms,
    )
