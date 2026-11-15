"""Isolated scientific entry point. Parent owns concurrency, deadline and cancellation."""

import json
import logging
import os
import sys
from queue import Queue
from threading import Thread
from time import perf_counter

import orjson
from fastapi import HTTPException

from app.services import preparation_control
from app.services.profiling import collect_phases
from app.services.result_cache import ResultCache, cached_result, exact_key

_results = ResultCache()

def calculate(operation, payload):
    key = exact_key(operation, payload, os.getenv("LUMEN_SCIENCE_REVISION", "standalone"))
    cached = _results.get(key) if operation == "search" and os.getenv("LUMEN_SCIENCE_REVISION") else None
    if cached is not None:
        cached["timings"] = {"exact_cache_hit": 0.0}
        return cached
    try:
        if operation == "prepare":
            from app.models import SearchRequest
            from app.services.ephemeris import load_kernels
            from app.services.hemisphere_survey import load
            from app.services.hemisphere_terrain import prepare, source
            from app.settings import settings

            with preparation_control.speculative():
                started = perf_counter()
                source()
                preparation_control.checkpoint()
                load_kernels(settings.kernel_root)
                preparation_control.checkpoint()
                from app.services.dataset import DataUnavailable
                survey_ready = False
                try:
                    load()  # The installed 827-site survey, never dense hemisphere preparation.
                    survey_ready = True
                except DataUnavailable:
                    if (payload.get("request") or {}).get("region", {}).get("selector_type") == "southern_hemisphere":
                        raise
                preparation_control.checkpoint()
                if payload.get("request") is not None:
                    request = SearchRequest.model_validate(payload["request"])
                    from app.services.validation import validate_search
                    validate_search(request, hemisphere=True)
                    prepare(request.region)
                result = {"state": "ready", "seconds": perf_counter() - started, "verified_sources": True, "survey_ready": survey_ready}
        elif operation == "search":
            from app.api import candidate_search_calculation
            from app.models import SearchRequest

            with collect_phases() as timings:
                called = False
                def compute():
                    nonlocal called
                    called = True
                    return candidate_search_calculation(SearchRequest.model_validate(payload))
                result = cached_result("search", orjson.dumps(payload, option=orjson.OPT_SORT_KEYS).decode(),
                                       os.getenv("LUMEN_SCIENCE_REVISION", "direct"), compute)
                if not called:
                    timings["exact_disk_cache_hit"] = 0.0
        elif operation == "preview":
            from app.global_api import GlobalPointRequest, preview_calculation

            result = preview_calculation(GlobalPointRequest.model_validate(payload))
        elif operation == "rank_area":
            from app.global_api import GlobalAreaRequest, area_ranking_calculation

            result = area_ranking_calculation(GlobalAreaRequest.model_validate(payload))
        elif operation == "compare":
            from app.models import CompareRequest
            from app.v2_api import compare_calculation

            result = compare_calculation(CompareRequest.model_validate(payload))
        elif operation == "replay":
            from app.v2_api import ReplayRequest, replay_calculation

            site_id = payload.pop("site_id")
            result = replay_calculation(site_id, ReplayRequest.model_validate(payload))
        elif operation == "metrics":
            from app.models import SearchRequest
            from app.v2_api import metrics_calculation

            result = metrics_calculation(SearchRequest.model_validate(payload))
        else:
            raise ValueError("Unknown analysis operation")
        response = {"result": result}
        if operation == "search":
            response["timings"] = timings
    except preparation_control.PreparationCanceled:
        response = {"canceled": True}
    except HTTPException as exc:
        response = {"error": exc.detail, "status": exc.status_code}
    except Exception:
        logging.getLogger(__name__).exception("Analysis worker failed")
        response = {
            "error": "Scientific calculation unavailable. Your inputs are retained.",
            "status": 503,
        }
    if operation == "search" and "result" in response and os.getenv("LUMEN_SCIENCE_REVISION"):
        _results.put(key, response)
    return response


def main():
    if sys.argv[1] == "serve":
        # Windows native DLL initialization can stall behind a blocking stdin reader.
        # Initialize scientific libraries once before starting that control thread.
        import numpy  # noqa: F401
        import spiceypy  # noqa: F401
        if os.getenv("LUMEN_TEMPORAL_KERNEL") == "compiled":
            import importlib
            importlib.import_module("app.services.temporal_kernel")
        commands = Queue(maxsize=2)

        def receive():
            for line in sys.stdin.buffer:
                envelope = orjson.loads(line)
                if envelope["operation"] == "cancel_prepare":
                    preparation_control.cancel.set()
                else:
                    if envelope["operation"] == "prepare":
                        preparation_control.cancel.clear()
                    commands.put(envelope)
            preparation_control.cancel.set()
            os._exit(0)  # Parent death/closed input must not leave a scientific worker orphaned.

        Thread(target=receive, daemon=True).start()
        while (envelope := commands.get()) is not None:
            preparing = envelope["operation"] == "prepare"
            if os.name == "nt":
                import ctypes
                ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000 if preparing else 0x20)
            response = calculate(envelope["operation"], envelope["payload"])
            if os.name == "nt":
                ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x20)
            sys.stdout.buffer.write(orjson.dumps(response) + b"\n")
            sys.stdout.buffer.flush()
            del response
    else:
        response = calculate(sys.argv[1], json.load(sys.stdin))
        sys.stdout.buffer.write(orjson.dumps(response))


if __name__ == "__main__":
    main()
