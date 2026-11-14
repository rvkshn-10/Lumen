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


class HorizonBand(BaseModel):
    labels: int
    disagreements: int


class HorizonDisagreement(BaseModel):
    sample_index: int
    body: Literal["sun", "earth"]
    clearance_deg: float
    near_horizon: bool
    model_visible: bool
    physics_visible: bool


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
    near_horizon_deg: float = NEAR_HORIZON_DEG
    near_horizon: HorizonBand
    outside_horizon_band: HorizonBand
    disagreements: list[HorizonDisagreement]
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
    )
    reference = np.asarray([[point.sun_visible, point.earth_visible] for point in samples])
    inputs = np.clip(clearance, -8, 8).astype(np.float32)
    started = perf_counter()
    try:
        output = compiled.create_infer_request().infer({0: inputs})[0]
    except RuntimeError as exc:
        raise RuntimeUnavailable("OpenVINO could not run the visibility model.") from exc
    elapsed_ms = (perf_counter() - started) * 1_000
    predicted = output > 0
    matched = predicted == reference
    paired = matched.all(axis=1)
    # Sun clearance uses a fixed radius here, even when the reference used its distance.
    limb_or_center_clearance = clearance + [SOLAR_RADIUS_DEG, 0]
    near = np.abs(limb_or_center_clearance) <= NEAR_HORIZON_DEG
    disagreements = [
        HorizonDisagreement(
            sample_index=int(index),
            body="sun" if body_index == 0 else "earth",
            clearance_deg=float(limb_or_center_clearance[index, body_index]),
            near_horizon=bool(near[index, body_index]),
            model_visible=bool(predicted[index, body_index]),
            physics_visible=bool(reference[index, body_index]),
        )
        for index, body_index in np.argwhere(~matched)
    ]
    return HorizonResult(
        runtime_version=version,
        samples=len(samples),
        agreement=float(paired.mean()),
        sun_agreement=float(matched[:, 0].mean()),
        earth_agreement=float(matched[:, 1].mean()),
        near_horizon_samples=int(near.any(axis=1).sum()),
        disagreement_indices=np.flatnonzero(~paired).tolist(),
        near_horizon=HorizonBand(
            labels=int(near.sum()), disagreements=int((near & ~matched).sum())
        ),
        outside_horizon_band=HorizonBand(
            labels=int((~near).sum()), disagreements=int((~near & ~matched).sum())
        ),
        disagreements=disagreements,
        inference_ms=elapsed_ms,
    )
