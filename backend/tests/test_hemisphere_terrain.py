from datetime import UTC, datetime, timedelta

import numpy as np
import pytest

from app.models import Coordinate, RegionSelection, SearchRequest, TimeRange
from app.services import hemisphere_terrain as terrain
from app.services.dataset import DataUnavailable
from app.services.validation import SearchValidationError, validate_search


def request(lat=-35, lon=0, radius=1):
    start = datetime(2028, 10, 1, tzinfo=UTC)
    return SearchRequest(
        region=RegionSelection(
            selector_type="circle",
            center=Coordinate(latitude_deg=lat, longitude_deg_east=lon),
            search_radius_km=radius,
        ),
        time_range=TimeRange(start_utc=start, end_utc=start + timedelta(days=1)),
    )


def test_hemisphere_limits_and_northern_rejection():
    validate_search(request(), hemisphere=True)
    with pytest.raises(SearchValidationError, match="southern"):
        validate_search(request(1), hemisphere=True)
    with pytest.raises(SearchValidationError, match="5 km"):
        validate_search(request(radius=6), hemisphere=True)


def test_equator_lattice_clips_candidates_and_longitudes_wrap():
    _, _, lat, lon = terrain.lattice(request(0, 179.999, 5).region)
    assert np.all(lat <= 0) and np.all(lon >= -180) and np.all(lon < 180)
    assert (lon < 0).any() and (lon > 0).any()


def test_flat_reference_sphere_has_zero_slope_and_negative_horizon(monkeypatch):
    monkeypatch.setattr(
        terrain,
        "sample",
        lambda grids, lat, lon: np.zeros(np.broadcast_shapes(np.shape(lat), np.shape(lon))),
    )
    height, slope, roughness, profiles, blockers = terrain.derive(
        {}, np.array([-35.0, -80.0]), np.array([0.0, 179.0])
    )
    np.testing.assert_allclose(height, 0)
    np.testing.assert_allclose(slope, 0, atol=1e-10)
    np.testing.assert_allclose(roughness, 0, atol=1e-10)
    assert profiles.shape == (2, 72) and (profiles < 0).all()
    # Analytic angle from the same spherical geometry and 2 m observer height.
    angle = blockers / terrain.RADIUS
    expected = np.rad2deg(
        np.arctan2(
            terrain.RADIUS * np.cos(angle) - (terrain.RADIUS + 2), terrain.RADIUS * np.sin(angle)
        )
    )
    np.testing.assert_allclose(profiles, expected, atol=1e-10)


def test_sampler_wraps_longitude_joins_equator_and_converts_km_to_m():
    class Constant:
        def __init__(self, value):
            self.value = value

        def __getitem__(self, index):
            return np.full(index[0].shape, self.value)

    grids = {
        "south-000": Constant(1),
        "south-180": Constant(2),
        "north-000": Constant(3),
        "north-180": Constant(4),
    }
    np.testing.assert_allclose(
        terrain.sample(grids, np.array([-35, -35, 0]), np.array([90, -90, 90])), [1000, 2000, 2000]
    )
    np.testing.assert_allclose(
        terrain.sample(grids, -35, -0.001), terrain.sample(grids, -35, 359.999)
    )
    with pytest.raises(DataUnavailable):
        terrain.sample(grids, 8, 0)


def test_full_search_uses_derived_arrays_and_inspectable_ids(monkeypatch):
    from app.services.search import search

    monkeypatch.setattr(terrain, "source", lambda: ({"test": "synthetic-only"}, {}))
    monkeypatch.setattr(
        terrain,
        "sample",
        lambda grids, lat, lon: np.zeros(np.broadcast_shapes(np.shape(lat), np.shape(lon))),
    )
    req = request()
    prepared = terrain.prepare(req.region)
    result = search(req, prepared=prepared)
    assert result["counts"]["region"] > 0 and result["candidates"]
    assert all(site["id"].startswith("hemi-") for site in result["candidates"])
    assert result["provenance"]["terrain"]["dataset_version"] == terrain.VERSION
    from app.models import ScenarioRequest
    from app.services.sites import scenario_analysis, site_analysis

    site_id = result["candidates"][0]["id"]
    inspected = site_analysis(site_id,req)
    assert inspected["metrics"] == result["candidates"][0]["metrics"]
    scenario = scenario_analysis(ScenarioRequest(request=req,site_id=site_id,
                                                 delay_hours=1,offset_radius_m=500))
    assert scenario["baseline"]["metrics"] == inspected["metrics"]
