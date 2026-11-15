"""Check hosted hemisphere availability and execute a real one-day survey."""

import argparse
import json
from time import perf_counter
from urllib.request import Request, urlopen


def verify(base, days=1):
    def call(path, payload=None):
        request = Request(
            base.rstrip("/") + path,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Content-Type": "application/json"},
        )
        with urlopen(request, timeout=180) as response:
            return json.load(response)

    coverage = call("/api/v1/coverage")
    if not coverage.get("hemisphere_survey"):
        raise RuntimeError("Host lacks the verified hemisphere survey bundle.")
    started = perf_counter()
    mission = {
        "region": {"selector_type": "southern_hemisphere"},
        "time_range": {"start_utc": "2028-10-01T00:00:00Z", "end_utc": f"2028-10-{1 + days:02d}T00:00:00Z"},
    }
    result = call("/api/v1/candidates/search", mission)
    if result["counts"]["region"] != 827 or not result["candidates"]:
        raise RuntimeError("Survey did not return the expected 827 locations and shortlist")
    seconds = perf_counter() - started
    candidate = result["candidates"][0]
    detail = call(f"/api/v1/sites/{candidate['id']}/analysis?include_alternatives=false", mission)
    if detail["metrics"] != candidate["metrics"]:
        raise RuntimeError("Survey inspection does not match search metrics")
    return {"url": base, "hemisphere_survey": "passed", "locations": 827,
            "days": days, "inspection": "passed", "hemisphere_detailed": coverage.get("hemisphere_detailed"),
            "seconds": round(seconds, 2)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--days", type=int, choices=range(1, 8), default=1)
    args = parser.parse_args()
    print(json.dumps(verify(args.url, args.days), indent=2))
