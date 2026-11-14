"""Suggestions must prove all constraints, including ones they do not name."""

from datetime import UTC, datetime, timedelta

import numpy as np
import pytest

from app.models import SearchRequest
from app.services import alternatives as service


@pytest.fixture
def setup(monkeypatch):
    arrays = {"ids": np.array(["source", "nearest-fails", "farther-passes"]),
              "lat_deg": np.array([-89.9] * 3), "lon_deg": np.array([0, 10, 20]),
              "slope_deg": np.array([8, 11, 4]), "roughness_m": np.zeros(3),
              "elevation_m": np.zeros(3)}
    monkeypatch.setattr(service, "load_site", lambda *_: ({}, arrays))
    monkeypatch.setattr(service, "great_circle_km", lambda *_: np.array([0, .5, 1]))
    start = datetime(2028, 10, 1, tzinfo=UTC)
    request = SearchRequest(region={"selector_type": "circle", "center": {
        "latitude_deg": -89.9, "longitude_deg_east": 0}, "search_radius_km": 3},
        time_range={"start_utc": start, "end_utc": start + timedelta(hours=1)},
        hard_constraints={"maximum_slope_deg": 10, "minimum_illumination_fraction": .5})
    monkeypatch.setattr("app.services.ephemeris.body_positions", lambda *_: ([start], None, None))
    monkeypatch.setattr(service, "positions_at_times", lambda _, times: (
        np.zeros((len(times), 3)), np.zeros((len(times), 3))))
    return arrays, request


def test_nearby_checks_every_limit_and_shifts_the_same_location_to_nearest_passing_day(setup, monkeypatch):
    arrays, request = setup
    monkeypatch.setattr(service, "analyze_batch", lambda *args: [
        {"illumination_fraction": .9}, {"illumination_fraction": .7}])
    evaluated = []

    def analyze(arrays, index, times, *_):
        evaluated.append((index, times[0]))
        return {"metrics": {"illumination_fraction": .8}}

    monkeypatch.setattr(service, "analyze", analyze)
    original = request.model_dump(mode="json")
    result = service.site_alternatives(request, arrays, 0, {"illumination_fraction": .2})
    nearby = next(row for row in result if row["kind"] == "nearby")
    assert nearby["id"] == "farther-passes"  # nearest fails an unrelated slope limit
    assert nearby["resolves"] == ["minimum_illumination_fraction"]
    assert nearby["distance_km"] <= nearby["search_radius_km"]
    shifted = next(row for row in result if row["kind"] == "shifted_window")
    assert shifted["id"] == "source" and shifted["shift_hours"] == -24
    assert evaluated == [(0, request.time_range.start_utc - timedelta(days=1))]
    assert request.model_dump(mode="json") == original
    assert all("0.2" in row["reason"] for row in result)
    relaxed = next(row for row in result if row["kind"] == "relaxed")
    assert relaxed["request"]["hard_constraints"]["minimum_illumination_fraction"] == .2
    assert not service.failures(SearchRequest.model_validate(relaxed["request"]),
                                {**relaxed["metrics"], **relaxed["terrain"]})


def test_no_passing_neighbor_or_date_is_not_fabricated(setup, monkeypatch):
    arrays, request = setup
    monkeypatch.setattr(service, "analyze_batch", lambda *args: [
        {"illumination_fraction": .1}, {"illumination_fraction": .1}])
    dates = []

    def analyze(_, __, times, *args):
        dates.append(times[0])
        return {"metrics": {"illumination_fraction": .1}}

    monkeypatch.setattr(service, "analyze", analyze)
    result = service.site_alternatives(request, arrays, 0, {"illumination_fraction": .2})
    assert [row["kind"] for row in result] == ["relaxed"]
    assert len(dates) == 60
    assert min(dates) == request.time_range.start_utc - timedelta(days=30)
    assert max(dates) == request.time_range.start_utc + timedelta(days=30)


def test_static_failure_never_claims_date_can_fix_terrain_or_hides_multiple_relaxations(setup, monkeypatch):
    arrays, request = setup
    request.hard_constraints.maximum_slope_deg = 1
    monkeypatch.setattr(service, "analyze_batch", lambda *args: [
        {"illumination_fraction": .9}, {"illumination_fraction": .9}])
    monkeypatch.setattr(service, "positions_at_times", lambda *_: pytest.fail("Static failure scanned dates"))
    assert service.site_alternatives(request, arrays, 0, {"illumination_fraction": .2}) == []
