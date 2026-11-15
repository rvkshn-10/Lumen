"""Measure exact engine searches, response serialization and a repeatable P95 gate.

This is a local engine benchmark, not an HTTP/concurrency or cold-disk benchmark.
Existing verified disk caches remain in use; --fresh-process resets process caches.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import platform
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from time import perf_counter

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def summarize(runs: list[dict], target: float | None) -> dict:
    if not runs or any(not math.isfinite(row["total_s"]) or row["total_s"] < 0 for row in runs):
        raise ValueError("Benchmark requires finite, non-negative measurements")
    values = sorted(row["total_s"] for row in runs)
    # Nearest rank, without interpolation hiding the slow tail.
    p95 = values[math.ceil(.95 * len(values)) - 1]
    enough = len(values) >= 20
    return {"runs": len(values), "p95_s": p95, "maximum_s": values[-1],
            "p95_method": "nearest rank", "target_s": target,
            "gate": "not_requested" if target is None else
            "insufficient_samples" if not enough else "pass" if p95 < target else "fail"}


def measure(request) -> dict:
    from app.services.search import search

    timings: dict[str, float] = {}
    started = perf_counter()
    result = search(request, timings=timings)
    search_seconds = perf_counter() - started
    encoded = json.dumps(result, allow_nan=False, separators=(",", ":")).encode()
    return {"total_s": perf_counter() - started, "search_s": search_seconds,
            "stages_s": timings, "response_bytes": len(encoded),
            "counts": result["counts"], "search_id": result["search_id"],
            "provenance": result["provenance"]}


def main() -> None:
    from app.models import SearchRequest
    from app.settings import settings

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeat", type=int, default=2)
    parser.add_argument("--request", type=Path, help="Exact SearchRequest JSON to benchmark")
    parser.add_argument("--output", type=Path, help="Write a machine-readable timing report")
    parser.add_argument("--p95-target", type=float, help="Strict upper bound, e.g. 30, 5 or 1 seconds; requires 20 runs")
    parser.add_argument("--fresh-process", action="store_true", help="Measure each run in a separate interpreter; disk caches retained")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error("--repeat must be positive")
    if args.p95_target is not None and (not math.isfinite(args.p95_target) or args.p95_target <= 0):
        parser.error("--p95-target must be finite and positive")
    request = SearchRequest.model_validate_json(args.request.read_text()) if args.request else SearchRequest(
        region={"selector_type": "full_supported_region"},
        time_range={"start_utc": "2028-10-01T00:00:00Z", "end_utc": "2028-10-31T00:00:00Z"},
    )
    if args.worker:
        print(json.dumps(measure(request)))
        return
    runs = []
    for number in range(1, args.repeat + 1):
        if args.fresh_process:
            command = [sys.executable, str(Path(__file__).resolve()), "--worker"]
            if args.request:
                command += ["--request", str(args.request.resolve())]
            started = perf_counter()
            child = subprocess.run(command, check=True, text=True, capture_output=True)
            row = json.loads(child.stdout)
            row["process_wall_s"] = perf_counter() - started
        else:
            row = measure(request)
        row["run"] = number
        runs.append(row)
        print(json.dumps({key: value for key, value in row.items() if key != "provenance"}), flush=True)
    report = {"schema_version": 1, "created_utc": datetime.now(UTC).isoformat(),
              "scope": "local exact engine plus JSON serialization; excludes HTTP, queue and concurrency",
              "process_cache": "fresh process per run" if args.fresh_process else "shared process; first run included",
              "disk_cache": "existing verified disk caches retained",
              "platform": platform.platform(), "python": platform.python_version(),
              "data_root": str(settings.data_root.resolve()),
              "request": request.model_dump(mode="json"), "measurements": runs,
              "summary": summarize(runs, args.p95_target)}
    metadata = settings.data_root / ("catalog.json" if (settings.data_root / "catalog.json").exists() else "metadata.json")
    report["dataset_manifest_sha256"] = hashlib.sha256(metadata.read_bytes()).hexdigest()
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report["summary"]))
    if report["summary"]["gate"] in ("fail", "insufficient_samples"):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
