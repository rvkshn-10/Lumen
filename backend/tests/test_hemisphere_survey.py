import json
import shutil
from datetime import UTC, datetime, timedelta

import numpy as np
import pytest

from app.models import RegionSelection, SearchRequest, TimeRange
from app.services import hemisphere_survey as survey
from app.services.dataset import DataUnavailable
from app.services.terrain_store import digest
from app.services.validation import SearchValidationError, validate_search


def test_grid_covers_south_with_consistent_regional_spacing():
    lat, lon = survey.grid()
    assert len(lat) > 700 and len(lat) < 1000
    assert lat.min() == -87.5 and lat.max() == -2.5
    assert (lon >= -180).all() and (lon < 180).all()
    assert len(set(zip(lat, lon, strict=True))) == len(lat)
    for latitude in np.unique(lat):
        count = np.count_nonzero(lat == latitude)
        assert abs(count - 72 * np.cos(np.deg2rad(latitude))) < 0.51


@pytest.fixture
def installed(tmp_path, monkeypatch):
    metadata = {"test": "synthetic survey only"}
    from app import global_api

    monkeypatch.setattr(
        global_api, "global_grid", lambda: ({"test": "coarse source"}, np.zeros((2, 4)))
    )
    monkeypatch.setattr(survey, "source", lambda: (metadata, {}))
    monkeypatch.setattr(survey, "ROOT", tmp_path)
    survey._load.cache_clear()
    directory = tmp_path / "survey"
    directory.mkdir()
    lat, lon = survey.grid()
    n = len(lat)
    path = directory / "terrain.npz"
    np.savez_compressed(
        path,
        ids=np.array([f"hemi-survey-{i:04d}" for i in range(n)]),
        lat_deg=lat,
        lon_deg=lon,
        x_m=np.arange(n) * 200000.0,
        y_m=np.zeros(n),
        elevation_m=np.zeros(n),
        slope_deg=np.zeros(n),
        roughness_m=np.zeros(n),
        horizons_deg=np.full((n, 72), -1.0),
        blocker_distance_m=np.full((n, 72), 1000.0),
        horizon_azimuth_deg=np.arange(0, 360, 5),
    )
    (directory / "manifest.json").write_text(
        json.dumps(
            {
                "version": survey.VERSION,
                "source_fingerprint": survey.fingerprint(
                    {"detailed": metadata, "global": {"test": "coarse source"}}
                ),
                "sha256": digest(path),
                "bytes": path.stat().st_size,
            }
        )
    )
    return directory


def test_whole_hemisphere_search_and_inspection(installed):
    from app.services.search import search
    from app.services.sites import site_analysis

    start = datetime(2028, 10, 1, tzinfo=UTC)
    request = SearchRequest(
        region=RegionSelection(selector_type="southern_hemisphere"),
        time_range=TimeRange(start_utc=start, end_utc=start + timedelta(days=1)),
    )
    validate_search(request, hemisphere=True)
    metadata, arrays = survey.load()
    result = search(request, prepared=(metadata, arrays))
    assert result["counts"]["region"] == len(survey.grid()[0])
    assert result["survey"]["scope"] == "southern_hemisphere"
    assert result["terrain_data"] is None
    site = result["candidates"][0]
    detail = site_analysis(site["id"], request)
    assert detail["metrics"] == site["metrics"]
    assert any("150 km" in warning for warning in result["warnings"])


def test_stale_or_corrupt_survey_cannot_be_advertised(installed):
    assert survey.ready()
    (installed / "terrain.npz").write_bytes(b"corrupt")
    assert not survey.ready()
    with pytest.raises(DataUnavailable):
        survey.load()


def test_whole_hemisphere_keeps_seven_day_limit():
    start = datetime(2028, 10, 1, tzinfo=UTC)
    request = SearchRequest(
        region=RegionSelection(selector_type="southern_hemisphere"),
        time_range=TimeRange(start_utc=start, end_utc=start + timedelta(days=8)),
    )
    with pytest.raises(SearchValidationError, match="7 days"):
        validate_search(request, hemisphere=True)


@pytest.fixture
def bundled(tmp_path, monkeypatch):
    from app import global_api

    directory = tmp_path / "bundle"
    shutil.copytree(survey.BUNDLE_ROOT, directory)
    provenance = json.loads((directory / "manifest.json").read_text())
    monkeypatch.setattr(survey, "ROOT", tmp_path / "missing-raw-dem")
    monkeypatch.setattr(survey, "BUNDLE_ROOT", directory)
    monkeypatch.setattr(global_api, "global_grid", lambda: (provenance["global_source"], None))
    survey._load.cache_clear()
    return directory


def test_bundled_survey_search_and_inspection_without_raw_dem(bundled):
    from app.services.search import search
    from app.services.sites import site_analysis

    metadata, arrays = survey.load()
    request = SearchRequest(region=RegionSelection(selector_type="southern_hemisphere"),
                            time_range=TimeRange(start_utc="2028-10-01T00:00:00Z",
                                                 end_utc="2028-10-02T00:00:00Z"))
    result = search(request, prepared=(metadata, arrays))
    assert result["counts"]["region"] == 827
    candidate = result["candidates"][0]
    assert site_analysis(candidate["id"], request)["metrics"] == candidate["metrics"]


@pytest.mark.parametrize("filename", ["manifest.json", "terrain.npz"])
def test_bundled_survey_rejects_corruption(bundled, filename):
    assert survey.ready()
    (bundled / filename).write_bytes(b"corrupt")
    assert not survey.ready()


def test_bundled_survey_rejects_changed_global_source(bundled, monkeypatch):
    from app import global_api

    monkeypatch.setattr(global_api, "global_grid", lambda: ({"changed": True}, None))
    assert not survey.ready()


def test_survey_only_coverage_never_advertises_detailed_terrain(bundled, monkeypatch):
    from app import coverage_api
    from app.services import hemisphere_terrain, search_runtime

    monkeypatch.setattr(hemisphere_terrain, "ready", lambda: False)
    monkeypatch.setattr(search_runtime, "instance", None)
    coverage = coverage_api.catalog()
    assert coverage["hemisphere_survey"] is True
    assert coverage["hemisphere_detailed"] is False
