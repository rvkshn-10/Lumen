# OpenVINO horizon review

From the scenario board, open a site's **Charts** and select **Run OpenVINO review**. Lumen compares a small neural network's Sun and Earth visibility predictions with the site's existing timeline. The result shows agreement per body and timestamp, then groups disagreements by distance from the terrain horizon. Select **Show in chart** to jump to the exact physics sample and inspect the elevation, terrain angle, and visibility together. Mission ranking continues to use the physics model.

## How it works

1. The app sends timestamped Sun and Earth elevations, the modeled local terrain horizons, and the original visibility labels for up to 2,048 samples. Longer timelines are sampled evenly.
2. The API subtracts the terrain horizon from each elevation and clips the two angles to ±8°. A neural network with one 12-unit ReLU layer predicts two visibility labels. The training generator uses synthetic angles and a varied solar radius around 0.267°. The input deliberately omits the changing radius, so the model is approximate near a transition.
3. [Intel OpenVINO Runtime](https://docs.openvino.ai/2025/openvino-workflow/running-inference/inference-devices-and-modes/cpu-device.html) compiles the saved weights into a CPU model. Original labels are compared after inference. The API marks a sample as a joint match only when both labels match. The review groups each Sun or Earth label by its own angular clearance. Near-horizon labels are within ±0.1° of the terrain, measured from Earth's center or an approximate Sun upper edge using a fixed 0.2666° solar radius.
4. The backend reports inference time for the model call. End-to-end latency also includes transport, request validation and, on first use, model compilation.

Use the review to inspect where the simplified model is sensitive to the visibility boundary. A disagreement outside the band warrants checking the input angles and model behavior. The band is a review filter. Terrain uncertainty, landing safety and radio-link reliability require separate evidence.

## Reproduce the results

Use Python 3.12 and the optional local runtime. There are no paid API calls for inference.

```sh
python -m pip install -e './backend[dev,openvino]'
CI=1 python -m pytest backend/tests/test_horizon_api.py
python scripts/data/prepare_kernels.py
python scripts/data/install_cap_release.py
npm ci
npm run build
CI=1 python -m uvicorn app.main:app --app-dir backend
```

Open http://127.0.0.1:8000, choose **Open the demo comparison**, then open Site B’s **Charts**. The cap and kernel installers verify checksums before the demonstration.

When running the existing Docker build, pass `--build-arg LUMEN_OPENVINO=1` to include the optional runtime. The default image leaves the runtime out, and the app displays a recoverable message if an OpenVINO review is requested. See [Intel's runtime requirements](https://docs.openvino.ai/2025/about-openvino/release-notes-openvino/system-requirements.html).

To regenerate weights and check against an exported analysis:

```sh
python scripts/ai/train_horizon_review.py
CI=1 python scripts/ai/evaluate_horizon_review.py analysis-export.json
```

The held-out synthetic test matched both labels at 99.54% of 8,192 timestamps. On the three October 5–12, 2028 site timelines from the [independent contract fixture](https://github.com/rvkshn-10/Lumen/pull/2), OpenVINO 2025.4.1 on an Apple M4 CPU matched both labels at 6,034 of 6,051 timestamps (99.72%). All 17 disagreements were in the 178 individual near-horizon labels (9.55%). All 11,924 labels outside that band agreed. At one site on October 9 at 07:10 UTC, Earth was 0.0037° below the modeled skyline. The physics timeline marked Earth blocked and the learned model marked it visible. These results describe this fixture on an Apple M4 CPU.
