"""Process-cold (OS file cache uncontrolled) warm-up/foreground comparison on installed data."""

import asyncio
import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import psutil

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.services import bounded_analysis, search_runtime, worker_pool
from fastapi import HTTPException


class Connected:
    def __init__(self):
        self.state = SimpleNamespace()

    async def is_disconnected(self):
        return False


async def prepared(runtime):
    async with asyncio.timeout(195):
        while runtime.background is not None:
            runtime.status()  # Model the browser renewing its active preparation lease.
            await asyncio.sleep(0.1)
    if runtime.status()["state"] != "ready":
        raise RuntimeError(runtime.status())


def scientific(result):
    return {key: value for key, value in result.items() if key != "search_id"}


async def main():
    output = ROOT / "data/cache/warmup-benchmark" / str(time.time_ns())
    output.mkdir(parents=True)
    survey = json.loads((ROOT / "bench/intel-search-20261115/request.json").read_text(encoding="utf-8"))
    local = {**survey, "region": {"selector_type": "circle", "center": {
        "latitude_deg": -80, "longitude_deg_east": 90}, "search_radius_km": 1},
        "time_range": {"start_utc": "2028-10-01T00:00:00Z", "end_utc": "2028-10-02T00:00:00Z"}}
    results, references = [], {}
    for case, enabled, mode, request in [
        ("survey_disabled", False, "none", survey),
        ("survey_prepared", True, "ready", survey),
        ("survey_during_startup", True, "during", survey),
        ("local_disabled", False, "none", local),
        ("local_during_preparation", True, "local_during", local),
        ("local_area_changes", True, "changes", local),
    ]:
        print(f"Starting {case}", flush=True)
        environment = bounded_analysis.worker_environment()
        environment["LUMEN_RESULT_CACHE_ROOT"] = str(output / case)
        environment["LUMEN_REUSE_WORKER"] = "1"
        runtime = search_runtime.SearchRuntime(environment, enabled=enabled)
        # The existing bounded runner obtains its environment through this factory.
        original = bounded_analysis.worker_environment
        bounded_analysis.worker_environment = lambda environment=environment: environment
        available_mib = psutil.virtual_memory().available / 2**20
        before = time.perf_counter()
        try:
            await runtime.start()
            startup_return = time.perf_counter() - before
            if mode in ("ready", "changes", "local_during"):
                await prepared(runtime)
            elif mode == "during":
                await asyncio.sleep(0.1)
            startup_ready = time.perf_counter() - before
            startup_peak = (runtime.job or {}).get("peak_resident_bytes", 0)
            area_seconds = None
            if mode in ("changes", "local_during"):
                area_started = time.perf_counter()
                if mode == "changes":
                    other = {**local, "region": {**local["region"], "center": {
                        "latitude_deg": -35, "longitude_deg_east": 0}}}
                    await runtime.prepare(other)
                    await asyncio.sleep(0.15)
                await runtime.prepare(local)
                if mode == "changes":
                    await prepared(runtime)
                else:
                    await asyncio.sleep(0.15)
                area_seconds = time.perf_counter() - area_started
            foreground = Connected()
            started = time.perf_counter()
            response = await runtime.foreground("search", request, foreground, bounded_analysis._bounded_analysis)
            first = time.perf_counter() - started
            group = "survey" if request["region"]["selector_type"] == "southern_hemisphere" else "local"
            if group in references:
                assert scientific(response) == references[group], f"Scientific mismatch in {case}"
            else:
                references[group] = scientific(response)
            started = time.perf_counter()
            repeat = await runtime.foreground("search", request, Connected(), bounded_analysis._bounded_analysis)
            warm = time.perf_counter() - started
            assert response == repeat
            row = {"case": case, "available_memory_mib": available_mib, "startup_return_seconds": startup_return,
                   "startup_wait_seconds": startup_ready, "area_preparation_seconds": area_seconds,
                   "first_foreground_seconds": first, "exact_repeat_seconds": warm,
                   "background_peak_rss_mib": max(startup_peak, (runtime.job or {}).get("peak_resident_bytes", 0)) / 2**20,
                   "timings": getattr(foreground.state, "search_timings", {}),
                   "identical_science": True}
            results.append(row)
            (output / "report.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
            print(json.dumps(row), flush=True)
        except (HTTPException, RuntimeError, AssertionError, TimeoutError, OSError, ValueError) as error:
            row = {"case": case, "available_memory_mib": available_mib, "error": str(error), "elapsed_seconds": time.perf_counter() - before,
                   "state": runtime.status(), "peak_rss_mib": (runtime.job or {}).get("peak_resident_bytes", 0) / 2**20}
            results.append(row)
            (output / "report.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
            print(json.dumps(row), flush=True)
        finally:
            await runtime.close()
            bounded_analysis.worker_environment = original
            worker_pool.discard()
    print(f"Report: {output / 'report.json'}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
