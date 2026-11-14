"""Real-kernel integration across the Track A API, not the contract mock."""

import base64
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.global_api import GLOBAL_ROOT
from app.main import app
from app.models import SearchRequest
from app.services.ephemeris import KERNEL_FILES
from app.services.search import search
from app.services.sites import site_analysis
from app.settings import settings
from app.v2_api import ReplayRequest, replay_calculation


@pytest.fixture(scope="module")
def analysis():
    if not all((settings.kernel_root / name).exists() for name in KERNEL_FILES):
        pytest.skip("Prepare the pinned NAIF kernels")
    request = SearchRequest(region={"selector_type": "full_supported_region"},
                            time_range={"start_utc": "2028-10-05T00:00:00Z",
                                        "end_utc": "2028-10-06T00:00:00Z"},
                            hard_constraints={"maximum_slope_deg": 10})
    return search(request)


def test_search_and_inspection_agree_on_every_v2_number(analysis):
    candidate = analysis["candidates"][0]
    detail = site_analysis(candidate["id"], SearchRequest.model_validate(analysis["request"]))
    for key in ("metrics", "power", "events", "dte", "next_sunset", "next_earthset", "timeline"):
        assert detail[key] == candidate[key]
    assert all(row["sun_distance_km"] > 140e6 for row in candidate["timeline"])
    assert all(row["suitability_class"] in (0, 1, 2, 3) for row in analysis["map_candidates"])


def test_compare_preserves_four_input_locations_and_never_reranks(analysis):
    sites = list(reversed(analysis["candidates"][:4]))
    payload = {key: analysis["request"][key] for key in
               ("time_range", "preferences", "hard_constraints", "power", "dte_margin_deg")}
    payload["sites"] = [{"site_id": row["id"]} for row in sites]
    response = TestClient(app).post("/api/v1/compare", json=payload)
    assert response.status_code == 200, response.text
    result = response.json()
    assert [row["id"] for row in result["candidates"]] == [row["id"] for row in sites]
    for expected, actual in zip(sites, result["candidates"], strict=True):
        assert actual["rank"] is None
        assert actual["metrics"] == expected["metrics"]
        assert actual["power"] == expected["power"]
    # An exact grid coordinate selects that point, without snapping to a different site.
    payload["sites"] = [{"latitude_deg": sites[0]["latitude_deg"],
                         "longitude_deg_east": sites[0]["longitude_deg_east"]}]
    result = TestClient(app).post("/api/v1/compare", json=payload)
    assert result.status_code == 200, result.text
    assert result.json()["candidates"][0]["id"] == sites[0]["id"]


def test_quantized_layer_is_complete_and_decodes_within_half_a_bin(analysis):
    start, end = (analysis["request"]["time_range"][key] for key in ("start_utc", "end_utc"))
    response = TestClient(app).get("/api/v1/layers/metrics", params={"window": f"{start}/{end}"})
    assert response.status_code == 200, response.text
    layer = response.json()
    assert layer["count"] == analysis["counts"]["total"]
    assert layer["metric_columns_bytes"] == layer["count"] * 5
    for candidate in analysis["candidates"]:
        index = layer["site_ids"].index(candidate["id"])
        for key, column in layer["columns"].items():
            data = np.frombuffer(base64.b64decode(column["data"]), dtype=np.uint8)
            assert len(data) == layer["count"]
            decoded = data[index] * column["scale"] + column["offset"]
            truth = candidate["metrics"].get(key, candidate.get(key))
            assert abs(decoded - truth) <= column["scale"] / 2 + 1e-9


def test_curated_catalog_contains_all_nine_regions_and_cited_landings():
    response = TestClient(app).get("/api/v1/curated-sites")
    assert response.status_code == 200
    catalog = response.json()
    sites = catalog["sites"]
    assert len({site["id"] for site in sites}) == len(sites)
    assert sum(site["kind"] == "artemis_region" for site in sites) == 9
    assert sum(site["kind"] == "historic" for site in sites) == 24
    assert all(site["source_url"].startswith("https://") for site in sites)
    assert all(-90 <= site["latitude_deg"] <= 90 and -180 <= site["longitude_deg_east"] < 180
               for site in sites)
    assert any(site["latitude_deg"] > 0 for site in sites)
    assert TestClient(app).post("/api/v1/historic/not-a-landing/replay").status_code == 404


def test_compare_reports_unknown_sites_and_invalid_clock_without_fabricating_data():
    client = TestClient(app)
    window = {"start_utc": "2028-10-01T00:00:00Z", "end_utc": "2028-10-02T00:00:00Z"}
    response = client.post("/api/v1/compare", json={"sites": [{"site_id": "not-a-site"}],
                                                    "time_range": window})
    assert response.status_code == 404
    response = client.post("/api/v1/compare", json={"sites": [{"site_id": "not-a-site"}],
        "time_range": window, "scrub_time_utc": "2028-10-03T00:00:00Z"})
    assert response.status_code == 422
    assert client.get("/api/v1/layers/metrics", params={"window": "not-a-window"}).status_code == 422


@pytest.mark.parametrize("site_id,expected", [
    ("apollo-11", 10.8), ("apollo-12", 5.1), ("apollo-14", 10.3),
    ("apollo-15", 12.2), ("apollo-16", 14.8), ("apollo-17", 13.3)])
def test_actual_replay_touchdown_sun_angles_match_published_mission_values(site_id, expected):
    if not (GLOBAL_ROOT / "metadata.json").exists() or not (settings.kernel_root / "manifest.json").exists():
        pytest.skip("Prepare global terrain and kernels")
    result = replay_calculation(site_id, ReplayRequest())
    assert result["touchdown"]["sun_elevation_deg"] == pytest.approx(expected, abs=.3)
    assert len(result["landing_day"]["timeline"]) == 289
    assert len(result["mission_window"]["timeline"]) == 4033
    assert all(row["sun_horizon_deg"] == 0 for row in result["mission_window"]["timeline"])
    assert all("blocker_latitude_deg" not in row for row in result["mission_window"]["horizon"])
    assert "flat" in result["warnings"][0].lower()


def test_historic_fixture_is_a_source_golden_not_output_from_the_app():
    path = Path(__file__).resolve().parents[2] / "scripts/verify/fixtures/historic-apollo-12.json"
    fixture = json.loads(path.read_text())
    assert fixture["expected_sun_elevation_deg"] == 5.1
    assert fixture["source_url"].startswith("https://www.nasa.gov/")
