# Local mission copilot

Lumen can use OpenVINO GenAI to turn a plain-language brief into an editable draft. The local model interprets ranking intent. Lumen matches landmarks against its catalog and reads explicit dates and numeric limits from the brief. The app validates the draft and waits for the user to apply it. The science engine calculates coverage, ranking, Sun and Earth positions, and power estimates.

The comparison board can also request a plain-language explanation. The model chooses which tradeoff to emphasize. Lumen builds the explanation from the selected scenarios' calculated values.

## Run on your machine

Use Python 3.12 on a machine supported by [OpenVINO GenAI](https://docs.openvino.ai/2026/get-started/install-openvino/install-openvino-genai.html). Install the optional copilot dependency and download the model once. The tested model is the [OpenVINO INT4 export of Qwen2.5-Coder-0.5B-Instruct](https://huggingface.co/OpenVINO/Qwen2.5-Coder-0.5B-Instruct-int4-ov). The model directory is ignored by Git.

```sh
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -e './backend[copilot]' huggingface_hub
hf download OpenVINO/Qwen2.5-Coder-0.5B-Instruct-int4-ov \
  --revision 339876973306da551969e2d88991b7053be2029c \
  --local-dir data/cache/models/mission-copilot
```

If this is a fresh checkout, prepare the existing science data and build the web app before starting the server. The kernel and cap installers verify the downloaded artifacts. Global data is needed for the optional historic replays.

```sh
python scripts/data/prepare_kernels.py
python scripts/data/install_cap_release.py
npm ci
npm run build
```

Start the server on loopback. OpenVINO loads the model from the supplied directory, so drafting and explanations run locally. OpenVINO's `opt_in_out --opt_out` command disables its anonymous toolkit telemetry. [OpenVINO telemetry](https://docs.openvino.ai/2025/about-openvino/additional-resources/telemetry.html)

```sh
HF_HUB_OFFLINE=1 LUMEN_COPILOT_MODEL_DIR="$PWD/data/cache/models/mission-copilot" \
  python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1
```

Open **http://127.0.0.1:8000**. Choose a prepared site and continue to **Describe the mission**. Open **Start with a mission brief** and try “Near Shackleton, use a 2 km search radius, maximum slope 10°, and prioritize sunlight.” Select **Draft with OpenVINO**, review or edit the changes, then choose **Apply to mission form**. After a search, select at least two scenarios and open **Explain tradeoffs with OpenVINO**. The demo comparison also supports explanations.

The local server defaults to the phrase parser when no copilot model is configured. The public Render service uses that normal configuration. [OpenVINO structured output](https://openvinotoolkit.github.io/openvino.genai/docs/guides/structured-output/)
