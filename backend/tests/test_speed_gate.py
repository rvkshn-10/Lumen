import importlib.util
import json
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "speed_runner", Path(__file__).resolve().parents[2] / "scripts/bench/run.py"
)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def test_nearest_rank_percentile():
    assert runner.percentile(list(range(1, 21)), 0.95) == 19
    assert runner.percentile([1, 2, 3], 0.95) == 3


def test_failed_requests_and_locked_cases_cannot_qualify(tmp_path, monkeypatch):
    path = tmp_path / "scenarios.json"
    path.write_text(
        json.dumps(
            {
                "seed": 1,
                "scenarios": [
                    {"name": "locked", "enabled": False},
                    {"name": "broken", "enabled": True, "path": "/search", "payload": {}},
                ],
            }
        )
    )

    def unavailable(*args, **kwargs):
        raise OSError("offline")

    monkeypatch.setattr(runner, "urlopen", unavailable)
    result = runner.run(path, "http://localhost", 20)
    assert not result["passed"] and not result["qualified"]
    assert result["locked"] == ["locked"]
    assert result["operations"]["broken"]["completed"] == 0
    with pytest.raises(ValueError, match="positive"):
        runner.run(path, "http://localhost", 0)


def test_baselines_are_machine_specific(tmp_path):
    path = tmp_path / "scenarios.json"
    path.write_text('{"seed": 1, "scenarios": []}')
    baseline = tmp_path / "baseline.json"
    baseline.write_text('{"machine": "another-machine"}')
    with pytest.raises(ValueError, match="does not match"):
        runner.run(path, "http://localhost", baseline=baseline)
