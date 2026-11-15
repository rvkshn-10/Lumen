"""Measure explicit Intel development radii; this is not a P95 release gate."""

import asyncio
import hashlib
import json
import platform
import sys
import time
from pathlib import Path

import orjson
import psutil

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT))

from app.services import bounded_analysis, search_runtime, worker_pool
from fastapi import HTTPException

from scripts.bench.search_warmup import Connected, prepared


async def main():
    output = ROOT / "data/cache/intel-radius" / str(time.time_ns())
    output.mkdir(parents=True)
    environment = bounded_analysis.worker_environment()
    environment.update(LUMEN_MAXIMUM_RADIUS_KM="15", LUMEN_REUSE_WORKER="1",
                       LUMEN_RESULT_CACHE_ROOT=str(output / "results"))
    original = bounded_analysis.worker_environment
    bounded_analysis.worker_environment = lambda: environment
    runtime = search_runtime.SearchRuntime(environment, enabled=True)
    report = {"processor": platform.processor(), "platform": platform.platform(),
              "memory_bytes": psutil.virtual_memory().total, "development_only": True,
              "latency_qualified": False, "cases": []}
    payload = json.loads((ROOT / "bench/intel-search-20261115/request.json").read_text(encoding="utf-8"))
    started = time.perf_counter()
    try:
        await runtime.start()
        await prepared(runtime)
        report["startup_preparation_seconds"] = time.perf_counter() - started
        report["scientific_revision"] = hashlib.sha256(orjson.dumps(worker_pool.source_revision(environment))).hexdigest()
        for radius in (5, 15):
            request = {**payload, "region": {"selector_type": "circle", "center": {
                "latitude_deg": -35, "longitude_deg_east": 0}, "search_radius_km": radius}}
            for mode in ("cold_geometry", "prepared_geometry"):
                print(f"Starting radius {radius} km, {mode}", flush=True)
                row = {"radius_km": radius, "days": 7, "mode": mode}
                try:
                    if mode == "prepared_geometry":
                        prep = time.perf_counter()
                        await runtime.prepare(request)
                        await prepared(runtime)
                        row["preparation_seconds"] = time.perf_counter() - prep
                        # A different exact window forces fresh mission science while reusing only geometry.
                        request = {**request, "time_range": {"start_utc": "2028-10-08T00:00:00Z", "end_utc": "2028-10-15T00:00:00Z"}}
                    connected = Connected()
                    peak = [0]
                    running = [True]
                    async def memory(running=running, peak=peak):
                        while running[0]:
                            if worker_pool._process is not None:
                                try:
                                    peak[0] = max(peak[0], search_runtime.resident_bytes(worker_pool._process))
                                except psutil.Error:
                                    pass
                            await asyncio.sleep(0.1)
                    monitor = asyncio.create_task(memory())
                    before = time.perf_counter()
                    try:
                        result = await runtime.foreground("search", request, connected, bounded_analysis._bounded_analysis)
                    finally:
                        running[0] = False
                        await monitor
                    row.update(seconds=time.perf_counter() - before, peak_resident_mib=peak[0] / 2**20,
                               count=result["counts"]["region"], shortlist=len(result["candidates"]),
                               timings=getattr(connected.state, "search_timings", {}))
                    path = output / f"radius-{radius}-{mode}.json"
                    path.write_text(json.dumps(result), encoding="utf-8")
                    row["result_path"] = str(path)
                    before = time.perf_counter()
                    repeated = await runtime.foreground("search", request, Connected(), bounded_analysis._bounded_analysis)
                    row["exact_repeat_seconds"] = time.perf_counter() - before
                    assert result == repeated
                    row["identical_repeat"] = True
                    assert result["counts"]["region"] == (317 if radius == 5 else 2821)
                    assert result["candidates"]
                except (HTTPException, RuntimeError, AssertionError, TimeoutError, OSError, ValueError) as exc:
                    row["error"] = str(exc)
                report["cases"].append(row)
                (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
                print(json.dumps(row), flush=True)
        print(f"Report: {output / 'report.json'}", flush=True)
    finally:
        await runtime.close()
        bounded_analysis.worker_environment = original


if __name__ == "__main__":
    asyncio.run(main())
