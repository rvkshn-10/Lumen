"""Compare full 15 km speculative geometry with the foreground reference result."""

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend"))

from app.services import bounded_analysis, search_runtime

from scripts.bench.search_warmup import Connected, prepared


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path)
    options = parser.parse_args()
    candidates = sorted((ROOT / "data/cache/intel-radius").glob("*/radius-15-cold_geometry.json"))
    if options.reference is None and not candidates:
        parser.error("Run intel_radius.py first or supply --reference")
    reference_path = options.reference or candidates[-1]
    reference = json.loads(reference_path.read_text(encoding="utf-8"))
    output = ROOT / "data/cache/intel-radius" / f"background-{time.time_ns()}"
    environment = bounded_analysis.worker_environment()
    environment.update(LUMEN_MAXIMUM_RADIUS_KM="15", LUMEN_REUSE_WORKER="1",
                       LUMEN_RESULT_CACHE_ROOT=str(output / "results"))
    runtime = search_runtime.SearchRuntime(environment, enabled=True)
    original = bounded_analysis.worker_environment
    bounded_analysis.worker_environment = lambda: environment
    try:
        await runtime.start()
        await prepared(runtime)
        print("Preparing the complete 15 km region in one-candidate background batches", flush=True)
        before = time.perf_counter()
        await runtime.prepare(reference["request"])
        await prepared(runtime)
        seconds = time.perf_counter() - before
        result = await runtime.foreground("search", reference["request"], Connected(), bounded_analysis._bounded_analysis)
        assert result == reference, "Background geometry changed the scientific result"
        report = {"radius_km": 15, "days": 7, "candidates": result["counts"]["region"],
                  "preparation_seconds": seconds, "identical_complete_result": True,
                  "peak_background_resident_mib": runtime.job.get("peak_resident_bytes", 0) / 2**20}
        output.mkdir(parents=True, exist_ok=True)
        (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report), flush=True)
    finally:
        await runtime.close()
        bounded_analysis.worker_environment = original


if __name__ == "__main__":
    asyncio.run(main())
