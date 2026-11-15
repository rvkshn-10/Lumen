"""Speed gates must not pass on a tiny sample or conceal a slow tail."""
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("benchmark_search", Path(__file__).with_name("benchmark_search.py"))
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


def test_small_samples_do_not_certify_a_tier():
    assert benchmark.summarize([{"total_s": .1}], 30)["gate"] == "insufficient_samples"


def test_nearest_rank_preserves_tail_and_strict_target():
    rows = [{"total_s": 1}] * 18 + [{"total_s": 30}, {"total_s": 40}]
    result = benchmark.summarize(rows, 30)
    assert result["p95_s"] == 30
    assert result["gate"] == "fail"
    assert benchmark.summarize(rows, 31)["gate"] == "pass"


@pytest.mark.parametrize("rows", [[], [{"total_s": float("nan")}], [{"total_s": -1}]])
def test_invalid_measurements_cannot_pass(rows):
    with pytest.raises(ValueError):
        benchmark.summarize(rows, 30)
