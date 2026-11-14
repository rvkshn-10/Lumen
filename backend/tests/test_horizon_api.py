import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import horizon_api
from app.main import app
from app.services import horizon_review
from app.services.horizon_review import RuntimeUnavailable

client = TestClient(app)
PATH = "/api/v1/ai/horizon-review"
SAMPLE = {
    "time_utc": "2028-10-05T00:00:00Z",
    "sun_elevation_deg": 1,
    "sun_horizon_deg": 0,
    "earth_elevation_deg": -1,
    "earth_horizon_deg": 0,
    "sun_visible": True,
    "earth_visible": False,
}


@pytest.mark.parametrize("samples", [[], [SAMPLE] * 2049, [{**SAMPLE, "earth_elevation_deg": 99}]])
def test_rejects_invalid_input(samples):
    assert client.post(PATH, json={"samples": samples}).status_code == 422


def test_reports_missing_runtime(monkeypatch):
    def unavailable(_samples):
        raise RuntimeUnavailable("No runtime.")

    monkeypatch.setattr(horizon_api, "review_horizon", unavailable)
    response = client.post(PATH, json={"samples": [SAMPLE]})
    assert response.status_code == 503
    assert response.json()["detail"] == "No runtime."


def test_cpu_model_compares_labels_after_inference():
    pytest.importorskip("openvino")
    samples = [
        SAMPLE,
        {**SAMPLE, "sun_visible": False},
        {
            **SAMPLE,
            "sun_elevation_deg": -1,
            "sun_visible": False,
            "earth_elevation_deg": 1,
            "earth_visible": True,
        },
    ]
    response = client.post(PATH, json={"samples": samples})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["engine"] == "OpenVINO"
    assert body["device"] == "CPU"
    assert body["agreement"] == pytest.approx(2 / 3)
    assert body["earth_agreement"] == 1
    assert body["sun_agreement"] == pytest.approx(2 / 3)
    assert body["disagreement_indices"] == [1]
    assert body["samples"] == len(samples)
    assert body["near_horizon"] == {"labels": 0, "disagreements": 0}
    assert body["outside_horizon_band"] == {"labels": 6, "disagreements": 1}
    assert body["disagreements"] == [
        {
            "sample_index": 1,
            "body": "sun",
            "clearance_deg": pytest.approx(1.2666),
            "near_horizon": False,
            "model_visible": True,
            "physics_visible": False,
        }
    ]
    assert body["inference_ms"] >= 0


def test_disagreement_is_grouped_by_the_body_that_differs(monkeypatch):
    class FixedPredictions:
        def create_infer_request(self):
            return self

        def infer(self, _inputs):
            return [np.asarray([[-1, 1], [1, -1]])]

    monkeypatch.setattr(horizon_review, "compiled_cpu_model", lambda: (FixedPredictions(), "test"))
    samples = [
        {**SAMPLE, "sun_elevation_deg": -0.25},
        {**SAMPLE, "earth_elevation_deg": 0.03, "earth_visible": True},
    ]
    response = client.post(PATH, json={"samples": samples})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["near_horizon_samples"] == 2
    assert body["disagreement_indices"] == [0, 1]
    assert body["near_horizon"] == {"labels": 2, "disagreements": 2}
    assert body["outside_horizon_band"] == {"labels": 2, "disagreements": 1}
    assert [
        (row["body"], row["near_horizon"], row["clearance_deg"]) for row in body["disagreements"]
    ] == [
        ("sun", True, pytest.approx(0.0166)),
        ("earth", False, -1),
        ("earth", True, 0.03),
    ]
