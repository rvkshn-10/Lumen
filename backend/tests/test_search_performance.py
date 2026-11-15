import json
from datetime import UTC, datetime, timedelta

import numpy as np
import pytest

from app.services.json_response import ScientificJSONResponse
from app.services.mapped_tiles import load_mapped, prepare_mapped
from app.services.profiling import collect_phases, phase
from app.services.search import analyze_batch
from app.services.terrain_store import digest


def test_profiling_is_nested_and_exception_safe():
    with (
        collect_phases() as outer,
        phase("load"),
        collect_phases() as inner,
        pytest.raises(ValueError),
        phase("failed"),
    ):
        raise ValueError("test")
    assert set(outer) == {"load"}
    assert set(inner) == {"failed"}


def test_encoder_preserves_decoded_values():
    value = {
        "unicode": "Moon – south",
        "number": 0.12345678901234567,
        "negative_zero": -0.0,
        "null": None,
        "flags": [True, False],
    }
    assert json.loads(ScientificJSONResponse(value).body) == value


@pytest.mark.parametrize("seed", range(5))
def test_vectorized_map_sample_keeps_exact_order_and_mandatory_sites(seed):
    from app.services.search import map_sample, map_sample_reference

    rng = np.random.default_rng(seed)
    arrays = {"x_m": rng.integers(-10000, 10000, 5000), "y_m": rng.integers(-10000, 10000, 5000)}
    order = rng.permutation(5000)
    ranked = [(float(5000 - j), str(i), int(i), {}, {}) for j, i in enumerate(order)]
    selected = [ranked[j] for j in [0, 1, 30, 100, 4999]]
    expected = map_sample_reference(ranked, arrays, selected, 200)
    assert map_sample(ranked, arrays, selected, 200) == expected


@pytest.mark.parametrize(
    "science",
    [
        (),
        ("distance_psr_km",),
        ("distance_science_feature_km",),
        ("distance_psr_km", "distance_science_feature_km"),
    ],
)
def test_column_ranking_is_bit_identical_to_scalar_reference(science):
    from test_validation import request_for

    from app.services.proximity import science_utility
    from app.services.ranking import rank_columns
    from app.services.search import METRIC_KEYS, category_scores, temporal_pass

    rng = np.random.default_rng(9182)
    n = 2000
    arrays = {
        key: rng.uniform(-100, 100, n).astype(np.float32)
        for key in ("slope_deg", "roughness_m", "elevation_m", *science)
    }
    arrays["ids"] = np.array([str(i) for i in range(n)])
    indices = rng.permutation(n)
    rows = [
        {key: float(rng.uniform(0, 1 if "fraction" in key else 168)) for key in METRIC_KEYS}
        for _ in indices
    ]
    anchors = {"slope_deg": [-10.0, 30.0], "roughness_m": [5.0, 5.0], "elevation_m": [-50.0, 50.0]}
    start = datetime(2028, 10, 1, tzinfo=UTC)
    request = request_for(start, start + timedelta(days=7))
    request.hard_constraints.minimum_illumination_fraction = 0.2
    request.hard_constraints.maximum_continuous_blackout_hours = 150
    weights = {
        "illumination": 0.35,
        "earth_visibility": 0.45,
        "terrain_safety": 0.15,
        "science_proximity": 0.05,
    }
    expected = []
    for i, metrics in zip(indices, rows, strict=True):
        if not temporal_pass(request, metrics):
            continue
        scores = category_scores(
            metrics,
            *(float(arrays[key][i]) for key in ("slope_deg", "roughness_m", "elevation_m")),
            168.0,
            anchors,
        )
        scores["science_proximity"] = science_utility(
            float(arrays["distance_psr_km"][i]) if "distance_psr_km" in arrays else None,
            float(arrays["distance_science_feature_km"][i])
            if "distance_science_feature_km" in arrays
            else None,
        )
        total = 100 * sum(weights[key] * (value or 0) for key, value in scores.items())
        expected.append((total, str(arrays["ids"][i]), int(i), scores, metrics))
    actual, materialize = rank_columns(request, arrays, indices, rows, weights, 168.0, anchors)
    assert [materialize(row) for row in actual] == expected


def test_mapped_tiles_reject_damage_and_stale_source(tmp_path):
    source = tmp_path / "terrain.npz"
    np.savez_compressed(source, heights=np.arange(100, dtype=np.float32))
    target = tmp_path / "mapped"
    prepare_mapped(source, target)
    arrays = load_mapped(target, digest(source), ["heights"])
    assert isinstance(arrays["heights"], np.memmap)
    assert not arrays["heights"].flags.writeable
    np.testing.assert_array_equal(arrays["heights"], np.arange(100))
    del arrays
    assert load_mapped(target, "stale", ["heights"]) is None
    (target / "heights.npy").write_bytes(b"broken")
    assert load_mapped(target, digest(source), ["heights"]) is None


def test_compiled_and_coarse_samples_match_reference(monkeypatch):
    pytest.importorskip("numba")
    from app.services.ephemeris import SUN_RADIUS_KM, horizon_at, local_sky
    from app.services.temporal_kernel import compiled_samples, evaluate_batch

    rng = np.random.default_rng(20261114)
    n, nt = 1000, 37
    arrays = {
        "lat_deg": rng.uniform(-90, -87, n),
        "lon_deg": rng.uniform(-180, 180, n),
        "elevation_m": rng.uniform(-5000, 5000, n),
        "horizons_deg": rng.uniform(-3, 8, (n, 72)),
    }
    angles = np.linspace(0, 0.1, nt)
    sun = np.column_stack([np.cos(angles), np.sin(angles), np.full(nt, 0.02)]) * 1.5e8
    earth = np.column_stack([np.cos(angles), np.sin(angles), np.full(nt, -0.03)]) * 384400
    indices = np.arange(n)
    for body, radius in [(sun, SUN_RADIUS_KM), (earth, 0.0)]:
        flags, disks, _ = compiled_samples(arrays, indices, body, radius)
        full, full_disk, _ = compiled_samples(arrays, indices, body, radius, coarse=False)
        np.testing.assert_array_equal(flags, full)
        np.testing.assert_allclose(disks, full_disk, atol=1e-12, rtol=0)
        for i in range(n):
            az, el, distance = local_sky(
                arrays["lat_deg"][i], arrays["lon_deg"][i], arrays["elevation_m"][i], body
            )
            expected = el + np.rad2deg(np.arcsin(radius / distance)) > horizon_at(
                arrays["horizons_deg"][i], az
            )
            np.testing.assert_array_equal(flags[i], expected)
    times = [datetime(2028, 10, 1, tzinfo=UTC) + timedelta(minutes=5 * j) for j in range(nt)]
    monkeypatch.setenv("LUMEN_TEMPORAL_KERNEL", "compiled")
    expected = analyze_batch(arrays, indices, times, sun, earth)
    actual = evaluate_batch(arrays, indices, times, sun, earth)
    for a, b in zip(actual, expected, strict=True):
        assert a == pytest.approx(b, abs=1e-9)


def test_underestimated_block_motion_is_detected():
    pytest.importorskip("numba")
    from app.services.temporal_kernel import block_drifts, sample_kernel

    lat, lon, height = np.array([-90.0]), np.array([0.0]), np.array([0.0])
    profiles = np.zeros((1, 72))
    body = np.column_stack([np.full(12, 384400.0), np.zeros(12), np.linspace(-20000, 20000, 12)])
    exact = sample_kernel(lat, lon, height, profiles, body, block_drifts(body), 0.0, False)[0]
    safe = sample_kernel(lat, lon, height, profiles, body, block_drifts(body), 0.0, True)[0]
    faulty = sample_kernel(lat, lon, height, profiles, body, np.zeros(1), 0.0, True)[0]
    np.testing.assert_array_equal(safe, exact)
    assert not np.array_equal(faulty, exact)


def test_optional_windows_compute_missing_tiles_and_never_reuse_subwindows(tmp_path, monkeypatch):
    from app.services import ephemeris, repository, search, tile_metrics

    start = datetime(2028, 11, 1, tzinfo=UTC)
    end = start + timedelta(days=7)
    tile_metrics.window_directory(tmp_path, start, end).mkdir(parents=True)
    for tile in ("a", "b"):
        (tmp_path / tile).mkdir()
        (tmp_path / tile / "metadata.json").write_text("{}")

    class Store:
        def load_ids(self, tile):
            return np.array([tile + "0"])

    monkeypatch.setattr(repository, "store", lambda root: Store())
    monkeypatch.setattr(tile_metrics, "cache_identity", lambda *args: {})
    monkeypatch.setattr(
        tile_metrics,
        "load_tile_metrics",
        lambda directory, tile, *args: (
            {key: np.array([1.0]) for key in search.METRIC_KEYS} if tile == "a" else None
        ),
    )
    monkeypatch.setattr(ephemeris, "body_positions", lambda *args: (None, None, None))
    evaluated = []

    def compute(arrays, indices, *args):
        evaluated.extend(indices.tolist())
        return [{key: 2.0 for key in search.METRIC_KEYS} for _ in indices]

    monkeypatch.setattr(search, "evaluate_metrics", compute)
    metadata = {"used_tile_ids": ["a", "b"], "scoring_reference": {"id": "test"}}
    arrays = {"ids": np.array(["a0", "b0"])}
    rows = repository.selected_metrics(
        tmp_path, metadata, arrays, np.array([0, 1]), tmp_path, start, end
    )
    assert evaluated == [1]
    evaluated.clear()
    columnar = repository.selected_metrics(
        tmp_path, metadata, arrays, np.array([0, 1]), tmp_path, start, end, columnar=True
    )
    assert tuple(columnar) == rows
    assert not columnar.columns["illumination_fraction"].flags.writeable
    assert rows[0]["illumination_fraction"] == 1
    assert rows[1]["illumination_fraction"] == 2
    evaluated.clear()
    repository.selected_metrics(
        tmp_path, metadata, arrays, np.array([0, 1]), tmp_path, start, end - timedelta(days=1)
    )
    assert evaluated == [0, 1]
