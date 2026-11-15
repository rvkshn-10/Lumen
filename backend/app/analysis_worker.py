"""Isolated scientific entry point. Parent owns concurrency, deadline and cancellation."""

import json
import logging
import sys

import orjson
from fastapi import HTTPException

from app.services.profiling import collect_phases


def calculate(operation, payload):
    try:
        if operation == "search":
            from app.api import candidate_search_calculation
            from app.models import SearchRequest

            with collect_phases() as timings:
                result = candidate_search_calculation(SearchRequest.model_validate(payload))
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
    except HTTPException as exc:
        response = {"error": exc.detail, "status": exc.status_code}
    except Exception:
        logging.getLogger(__name__).exception("Analysis worker failed")
        response = {
            "error": "Scientific calculation unavailable. Your inputs are retained.",
            "status": 503,
        }
    return response


def main():
    if sys.argv[1] == "serve":
        for line in sys.stdin.buffer:
            envelope = orjson.loads(line)
            response = calculate(envelope["operation"], envelope["payload"])
            sys.stdout.buffer.write(orjson.dumps(response) + b"\n")
            sys.stdout.buffer.flush()
            del response
    else:
        response = calculate(sys.argv[1], json.load(sys.stdin))
        sys.stdout.buffer.write(orjson.dumps(response))


if __name__ == "__main__":
    main()
