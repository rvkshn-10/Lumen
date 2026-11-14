"""Regression guards for verifier fixes, including pre-1972 replay precision."""

import importlib.util
from datetime import UTC, datetime
from pathlib import Path

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
