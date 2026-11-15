# Connecting Ridge crater sample

In **Browse lunar places → Features**, expand the crater inspection for the
Shackleton connecting ridge (C1). The evidence panel also offers it under
**Terrain & sky** when a prepared candidate lies inside the 640 × 640 m crop.
Lumen serves the checked-in image and boxes as static assets. Opening the sample
requires no model service or inference on the host.

The source is the 1 m/pixel LROC controlled south-pole average mosaic,
product `NAC_POLE_SOUTH_CM_AVG_P892S2250`. The sample is centered near 89.4398°S,
222.83°E, using a 640 × 640 window at zero-based column 33619, row 12138. The
window starts at X = −11869 m, Y = −12138 m in lunar south-polar stereographic
coordinates (reference radius 1,737,400 m, central meridian 0°E). Pixel values
are stretched between the crop’s 1st and 99th percentiles for model input and
display. Image credit NASA/GSFC/ASU and USGS.
[LROC product and image sources](https://data.lroc.im-ldi.com/lroc/view_rdr_product/NAC_POLE_SOUTH_CM_AVG_P892S2250)

The single-class detector is Caleb Fassett’s published `9_2025_lroc_ctrl_yolo.pt`
checkpoint, from a study that used the same south-polar mosaic. The archive is
listed under CC BY 4.0. The sample applies a 0.25 confidence threshold, filters
to boxes with both sides at least 15 m before clipping, and suppresses overlapping
boxes at IoU 0.5. The software reads the checkpoint with PyTorch’s restricted
loader and converts it to OpenVINO in FP32.
[Model archive and attribution](https://zenodo.org/records/18674422)
[Original paper and detection limitations](https://doi.org/10.3847/PSJ/ae5526)

Both runtimes returned the same 45 candidates, with largest raw differences of
0.00071 pixels for box coordinates and 0.00000227 for model scores. This checks
whether the conversion preserves predictions on this crop. The crop has no
independent labels to measure crater detection accuracy, and its relationship to
the training split is unverified. Shadows, overlapping craters and steep slopes
can affect coverage. Site scoring and landing analyses use the existing planner
inputs. The sample provides visual inspection.

## Reproduce locally

These optional dependencies are for the offline preparation script only. The
run was verified with Python 3.12 on Apple Silicon.

```bash
crater_sample_dir="$(mktemp -d)"
python3.12 -m venv "$crater_sample_dir/venv"
"$crater_sample_dir/venv/bin/python" -m pip install 'torch==2.15.0' 'torchvision==0.29.2' \
  'ultralytics==8.3.203' 'openvino==2026.3.0' 'rasterio==1.5.2' 'numpy==2.5.4' 'pillow==13.0.0'
mkdir -p "$crater_sample_dir/ultralytics"
curl -fL 'https://zenodo.org/records/18674422/files/9_2025_lroc_ctrl_yolo.pt?download=1' \
  -o "$crater_sample_dir/weights.pt"
YOLO_CONFIG_DIR="$crater_sample_dir/ultralytics" \
  "$crater_sample_dir/venv/bin/python" scripts/data/prepare_crater_sample.py \
  "$crater_sample_dir/weights.pt" "$crater_sample_dir/sample"
```

The script checks the checkpoint hash and reads the specific image window from
NASA over HTTP byte ranges. It checks the raw crop hash before running detection.
The full checkpoint and source mosaic are downloaded or read locally as needed
during preparation. The planner uses only the published sample below.

| Artifact | SHA-256 |
| --- | --- |
| Published checkpoint | `41bcdde38e479c833b12e6a42a623e5e57e3c00e9fccbe7477e68c2d6bf10a41` |
| Unstretched 640 × 640 image bytes, row-major | `189c717cf4243c2eb84f34b3d049f9159a9380bc79424e46978b3e6718c2b639` |
| [Display PNG](../apps/web/public/assets/connecting-ridge-nac.png) | `a7188b0bd33e1c846e5e10877ceab441be08d77bc1c1c8a6021f50a1602b0fa4` |

Detection boxes, crop footprint and measured parity are recorded in
[connecting-ridge-craters.json](../apps/web/src/data/connecting-ridge-craters.json).
