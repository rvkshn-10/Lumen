"""Regression guards for verifier fixes, including pre-1972 replay precision."""

import importlib.util
import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
import spiceypy as spice

from app.services.ephemeris import load_kernels
from app.settings import settings

path = Path(__file__).resolve().parents[2] / "scripts/verify/oracle_ephemeris.py"
spec = importlib.util.spec_from_file_location("independent_oracle", path)
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)


@pytest.mark.parametrize("date", ["1966-02-03T18:45:30", "1969-11-19T06:54:36",
                                  "1971-07-30T22:16:29", "1972-01-01T00:00:00",
                                  "2017-01-01T00:00:00", "2028-10-05T00:00:00"])
def test_independent_time_conversion_matches_pinned_naif_convention(date):
    if not (settings.kernel_root / "manifest.json").exists():
        pytest.skip("Prepare the pinned kernels")
    load_kernels(settings.kernel_root)
    ephemeris = oracle.Ephemeris(settings.kernel_root)
    time = datetime.fromisoformat(date).replace(tzinfo=UTC)
    assert ephemeris.utc_to_et(time) == pytest.approx(spice.str2et(date), abs=2e-6, rel=0)


@pytest.fixture
def verifier():
    path = Path(__file__).resolve().parents[2] / "scripts/verify/lumen_verify.py"
    spec = importlib.util.spec_from_file_location("independent_verifier", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_iterated_random_suites_do_not_recheck_dumps_without_source_results(verifier, monkeypatch):
    checked = []
    for name in ("suite_scene_parity", "suite_ui_parity"):
        monkeypatch.setattr(verifier, name, lambda rep, results, path: checked.append(results))
    ctx = SimpleNamespace(args=SimpleNamespace(suites=[], scene_dump="scene", ui_dump="ui"))
    results = [{"search_id": "real-export"}]
    verifier.run_once(ctx, results, 1, 24)
    verifier.run_once(ctx, [], 2, 36, check_parity=False)
    assert checked == [results, results]


def test_later_iteration_failure_is_reported_and_returns_nonzero(verifier, monkeypatch, tmp_path):
    calls = []

    def run_once(ctx, results, seed, sample, *, check_parity):
        calls.append(check_parity)
        report = verifier.Report()
        # A failure outside the random suites must never disappear from the gate.
        report.add("parity", "late failure", len(calls) == 1)
        return report

    monkeypatch.setattr(verifier, "Context", lambda args: None)
    monkeypatch.setattr(verifier, "load_results", lambda paths: [])
    monkeypatch.setattr(verifier, "run_once", run_once)
    assert verifier.main(["--result", "--cache", "--iterate", "3",
                          "--baseline", str(tmp_path / "baseline.json"),
                          "--report", str(tmp_path)]) == 1
    result = json.loads((tmp_path / "verify-report.json").read_text())
    assert result["summary"]["fail"] == 1
    assert result["meta"]["iterations"] == 2
    assert calls == [True, False]
