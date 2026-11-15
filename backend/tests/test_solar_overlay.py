"""The 3D solar-generation overlay must agree with the site's Estimated Solar Generation."""

import math

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.settings import settings

pytestmark = pytest.mark.skipif(
    not (settings.kernel_root / "manifest.json").exists(),
    reason="Run npm run prepare:data to install the pinned scientific kernels.",
)


def test_overlay_matches_site_power_series_and_marks_gaps():
    client = TestClient(app)
    search = client.post("/api/v1/candidates/search", json={
        "region": {"selector_type": "full_supported_region"},
        "time_range": {"start_utc": "2028-10-01T00:00:00Z", "end_utc": "2028-10-31T00:00:00Z"},
    })
    assert search.status_code == 200
    site = search.json()["candidates"][0]
    samples = site["power"]["series"]
    lit = next(sample for sample in samples if sample["vertical_w"] > 1)
    dark = next((sample for sample in samples if sample["vertical_w"] == 0), None)
    for sample in [lit] + ([dark] if dark else []):
        response = client.get("/api/v1/solar/overlay", params={"time_utc": sample["time_utc"], "probe_site_id": site["id"]})
        assert response.status_code == 200
        body = response.json()
        assert body["unit"] == "W"
        assert body["assumptions"]["area_m2"] == site["power"]["assumptions"]["area_m2"]
        assert body["assumptions"]["efficiency"] == site["power"]["assumptions"]["efficiency"]
        assert math.isclose(body["probe"]["watts"], sample["vertical_w"], rel_tol=1e-9, abs_tol=1e-6)
    coarse = body["coarse"]
    assert len(coarse["watts"]) == coarse["rows"] * coarse["columns"]
    assert min(coarse["watts"]) == 0  # the night side is a valid 0 W estimate
    if body["terrain"] is not None:
        values = body["terrain"]["watts"]
        assert len(values) == body["terrain"]["side"] ** 2
        assert any(value is None for value in values)  # no prepared site: unavailable, not 0 W
