"""Track A regression gates against the separately maintained numpy-only reference."""

import importlib.util
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
import pytest
from pydantic import ValidationError

from app.models import CompareRequest, PowerSettings, SearchRequest
from app.services.candidate_extras import enrich
from app.services.events import extract_events, next_events
from app.services.power import battery_survival, energy_wh, power_estimate, power_w
from app.services.result_cache import cached_result
from app.services.suitability import suitability_class

reference_path = Path(__file__).resolve().parents[2] / "scripts/verify/reference_models.py"
spec = importlib.util.spec_from_file_location("independent_reference", reference_path)
reference = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reference)


def test_power_and_battery_match_independent_reference_at_random_inputs():
    rng = np.random.default_rng(20261114)
    elevation = rng.uniform(-90, 90, 100)
    distance = rng.uniform(140e6, 160e6, 100)
    disk = rng.uniform(0, 1, 100)
    disk[:10] = 0
    for mount in ("horizontal", "vertical_tracking"):
        actual = power_w(elevation, distance, disk, area_m2=2.3, efficiency=.27, mount=mount)
        np.testing.assert_allclose(actual, reference.power_w(elevation, distance, disk,
                                   area_m2=2.3, efficiency=.27, mount=mount), atol=1e-12)
        assert np.all(actual[:10] == 0)
        hours = rng.uniform(.01, 1, len(actual) - 1)
        assert energy_wh(actual, hours) == reference.energy_wh(actual, hours)
        assert battery_survival(actual, hours, load_w=150, capacity_wh=2000, start_soc=.2) == (
            reference.battery_survival(actual, hours, load_w=150, capacity_wh=2000, start_soc=.2))


def test_power_integrates_full_grid_not_the_hourly_display_series():
    start = datetime(2028, 10, 1, tzinfo=UTC)
    timeline = [{"time_utc": (start + timedelta(minutes=m)).isoformat(),
                 "sun_elevation_deg": 0, "sun_distance_km": reference.AU_KM,
                 "solar_fraction": fraction}
                for m, fraction in [(0, 1), (5, 0), (10, .5), (12, 1)]]
    estimate = power_estimate(timeline)
    assert len(estimate["series"]) == 2
    assert estimate["energy_wh"] == pytest.approx(1361 * .3 * (5 / 60 + .5 * 2 / 60))
    assert estimate["horizontal_energy_wh"] == 0
    assert power_estimate(timeline, PowerSettings(area_m2=3))["energy_wh"] == pytest.approx(
        3 * estimate["energy_wh"])


def test_events_refine_actual_transitions_and_countdowns_use_scrub_time():
    start = datetime(2028, 10, 1, tzinfo=UTC)
    change = start + timedelta(seconds=92)
    timeline = [{"time_utc": (start + timedelta(minutes=m)).isoformat(),
                 "sun_visible": m == 0, "earth_visible": m > 0} for m in (0, 5, 10)]
    events = extract_events(timeline, lambda instant, body: instant < change if body == "sun"
                            else instant >= change)
    assert {row["type"] for row in events} == {"sunset", "earthrise"}
    for event in events:
        assert abs((datetime.fromisoformat(event["time_utc"]) - change).total_seconds()) <= 30
        assert event["uncertainty_minutes"] <= .5
    assert next_events(events, start)["next_sunset"] is not None
    assert next_events(events, start + timedelta(minutes=5))["next_sunset"] is None
    assert next_events(events, start)["next_earthset"] is None


def test_dte_margin_does_not_change_geometric_visibility_or_metrics():
    start = datetime(2028, 10, 1, tzinfo=UTC)
    request = SearchRequest(region={"selector_type": "full_supported_region"},
                            time_range={"start_utc": start, "end_utc": start + timedelta(hours=2)})
    timeline = [{"time_utc": (start + timedelta(hours=j)).isoformat(), "earth_elevation_deg": el,
                 "earth_horizon_deg": 1, "earth_visible": True, "sun_elevation_deg": 5,
                 "sun_visible": True, "solar_fraction": 1} for j, el in enumerate((2, 3, 4))]
    detail = {"metrics": {"earth_visibility_fraction": 1}, "timeline": timeline}
    enrich(detail, request, lambda *_: True, sun_distance=[reference.AU_KM] * 3)
    assert detail["metrics"]["earth_visibility_fraction"] == 1
    assert all(row["earth_visible"] for row in timeline)
    assert [row["dte_contact"] for row in timeline] == [False, False, True]
    assert detail["dte"]["contact_fraction"] == 0


def test_suitability_boundaries_unknown_and_clipping_match_reference():
    scores = [-1, 0, 24.9999, 25, 49.9999, 50, 74.9999, 75, 100, 101, np.nan]
    np.testing.assert_array_equal(suitability_class(scores), reference.suitability_class(scores))


def test_compare_contract_rejects_ambiguity_duplicates_and_more_than_four():
    window = {"start_utc": "2028-10-01T00:00:00Z", "end_utc": "2028-10-02T00:00:00Z"}
    invalid = [[{"site_id": "a"}] * 2, [{"site_id": str(j)} for j in range(5)],
               [{"site_id": "a", "latitude_deg": -89, "longitude_deg_east": 0}],
               [{"latitude_deg": -89}], []]
    for sites in invalid:
        with pytest.raises(ValidationError):
            CompareRequest(sites=sites, time_range=window)


def test_disk_cache_survives_worker_boundaries_and_fails_closed_on_damage(tmp_path):
    calls = []

    def calculation():
        calls.append(1)
        return {"metric": len(calls)}

    assert cached_result("compare", "request", "sources", calculation, root=tmp_path) == {"metric": 1}
    assert cached_result("compare", "request", "sources", calculation, root=tmp_path) == {"metric": 1}
    next(tmp_path.glob("*.json.gz")).write_bytes(b"corrupt")
    assert cached_result("compare", "request", "sources", calculation, root=tmp_path) == {"metric": 2}
    assert cached_result("compare", "request", "new sources", calculation, root=tmp_path) == {"metric": 3}
