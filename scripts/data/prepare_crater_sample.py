"""Reproduce the single Connecting Ridge crater inspection with local OpenVINO."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import openvino as ov
import rasterio
import torch
from PIL import Image
from rasterio.windows import Window
from torch import nn
from torchvision.ops import nms
from ultralytics.nn.modules import DFL, SPPF, Bottleneck, C2f, Concat, Conv, Detect
from ultralytics.nn.tasks import DetectionModel

PDS_PRODUCT = "NAC_POLE_SOUTH_CM_AVG_P892S2250"
PDS_SOURCE = (
    "https://pds.mcp.nasa.gov/data/store/img/lunar_reconnaissance_orbiter/pds4/"
    "lroc/lro-l-lroc-5-rdr/LROLRC_2001/EXTRAS/BROWSE/NAC_POLE/"
    f"NAC_POLE_SOUTH_CM_AVG/{PDS_PRODUCT}.PYR.TIF"
)
WEIGHTS_SHA256 = "41bcdde38e479c833b12e6a42a623e5e57e3c00e9fccbe7477e68c2d6bf10a41"
WINDOW = Window(col_off=33619, row_off=12138, width=640, height=640)
CROP_SHA256 = "189c717cf4243c2eb84f34b3d049f9159a9380bc79424e46978b3e6718c2b639"
MIN_SCORE = 0.25
MIN_SIDE_M = 15
NMS_IOU = 0.5


def load_detector(weights: Path):
    if hashlib.sha256(weights.read_bytes()).hexdigest() != WEIGHTS_SHA256:
        raise ValueError("Checkpoint SHA-256 does not match the published crater sample")

    # PyTorch's restricted loader permits these installed upstream layer types.
    # The checkpoint contains only the official YOLO and torch classes below.
    layers = [
        nn.SiLU, nn.BatchNorm2d, nn.ModuleList, nn.Sequential, nn.Conv2d,
        nn.MaxPool2d, nn.Upsample, Bottleneck, C2f, DFL, SPPF, Concat, Conv,
        Detect, DetectionModel,
    ]
    with torch.serialization.safe_globals(layers):
        checkpoint = torch.load(weights, map_location="cpu", weights_only=True)
    detector = checkpoint["model"].float().eval()
    output_head = detector.model[-1]
    output_head.export = True
    output_head.format = "openvino"
    output_head.dynamic = False
    return detector


def read_crop():
    # GDAL reads the requested window over HTTP byte ranges.
    with (
        rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_TIMEOUT="15"),
        rasterio.open(f"/vsicurl/{PDS_SOURCE}") as raster,
    ):
        if tuple(raster.transform)[:6] != (1, 0, -45488, 0, -1, 0):
            raise ValueError("Unexpected NASA tile transform")
        transform = raster.window_transform(WINDOW)
        pixels = raster.read(1, window=WINDOW, masked=True)

    if pixels.shape != (640, 640) or pixels.mask.any():
        raise ValueError("The NASA window must contain a full 640 × 640 crop")
    if hashlib.sha256(pixels.data.tobytes()).hexdigest() != CROP_SHA256:
        raise ValueError("NASA crop pixel hash does not match the published sample")
    low, high = np.percentile(pixels.compressed(), [1, 99])
    crop = (255 * np.clip((pixels.filled(low) - low) / (high - low), 0, 1)).astype(np.uint8)
    return crop, transform


def select_boxes(prediction):
    xywh = prediction[0, :4].T
    scores = prediction[0, 4]
    selected = (scores >= MIN_SCORE) & (np.minimum(xywh[:, 2], xywh[:, 3]) >= MIN_SIDE_M)
    xywh, scores = xywh[selected], scores[selected]
    boxes = np.column_stack([
        xywh[:, :2] - xywh[:, 2:] / 2,
        xywh[:, :2] + xywh[:, 2:] / 2,
    ])
    kept = nms(torch.from_numpy(boxes), torch.from_numpy(scores), NMS_IOU)
    return boxes[kept.numpy()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("weights", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    detector = load_detector(args.weights)
    crop, transform = read_crop()
    inputs = np.ascontiguousarray(np.broadcast_to(crop, (1, 3, 640, 640)), dtype=np.float32)
    inputs /= 255
    tensor = torch.from_numpy(inputs)
    with torch.inference_mode():
        reference = detector(tensor).numpy()
        converted = ov.convert_model(detector, example_input=tensor)
    runtime = ov.Core().compile_model(converted, "CPU", {"INFERENCE_PRECISION_HINT": "f32"})
    prediction = runtime(inputs)[0]

    baseline_boxes = select_boxes(reference)
    boxes = select_boxes(prediction)
    np.testing.assert_allclose(boxes, baseline_boxes, rtol=0, atol=0.01)
    image_path = args.output / "connecting-ridge-nac.png"
    Image.fromarray(crop).save(image_path)
    sample = {
        "crop": {
            "left": transform.c,
            "top": transform.f,
            "width": crop.shape[1],
            "height": crop.shape[0],
            "metersPerPixel": transform.a,
        },
        "minimumConfidence": MIN_SCORE,
        "minimumSideM": MIN_SIDE_M,
        "imageSource": f"https://data.lroc.im-ldi.com/lroc/view_rdr_product/{PDS_PRODUCT}",
        "modelSource": "https://zenodo.org/records/18674422",
        "boxes": np.clip(boxes, 0, 640).astype(float).round(2).tolist(),
        "verification": {
            "rawCropSha256": CROP_SHA256,
            "displayImageSha256": hashlib.sha256(image_path.read_bytes()).hexdigest(),
            "weightsSha256": WEIGHTS_SHA256,
            "rawScoreMaxDelta": float(np.max(np.abs(reference[0, 4] - prediction[0, 4]))),
            "rawBoxPositionMaxDeltaPx": float(np.max(np.abs(reference[0, :4] - prediction[0, :4]))),
        },
    }
    (args.output / "connecting-ridge-craters.json").write_text(json.dumps(sample, indent=2) + "\n")
    print(f"OpenVINO and PyTorch matched on {len(boxes)} crater candidates")


if __name__ == "__main__":
    main()
