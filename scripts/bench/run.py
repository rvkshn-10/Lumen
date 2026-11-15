"""Fixed HTTP scenarios. Errors and locked scenarios never count as fast searches."""

import gzip
import hashlib
import json
import math
import platform
import statistics
from datetime import UTC, datetime
from pathlib import Path
from time import perf_counter
from urllib.request import Request, urlopen


def percentile(values, fraction):
    return sorted(values)[max(0, math.ceil(len(values) * fraction) - 1)]


def run(scenarios, url, repeat=20, baseline=None, operations=None, budget="final", result_dir=None):
    if repeat < 1:
        raise ValueError("repeat must be positive")
    raw = Path(scenarios).read_bytes()
    config = json.loads(raw)
    machine = platform.node()
    report = {
        "schema_version": 1,
        "machine": machine,
        "platform": platform.platform(),
        "processor": platform.processor(),
        "python": platform.python_version(),
        "utc": datetime.now(UTC).isoformat(),
        "seed": config["seed"],
        "scenarios_sha256": hashlib.sha256(raw).hexdigest(),
        "repeat": repeat,
        "budget": budget,
        "operations": {},
        "locked": [],
    }
    previous = json.loads(Path(baseline).read_text()) if baseline else None
    if previous and any(
        previous.get(k) != report[k] for k in ("machine", "scenarios_sha256", "budget")
    ):
        raise ValueError("Baseline machine, scenarios or budget does not match")
    names = {row["name"] for row in config["scenarios"]}
    if operations and set(operations) - names:
        raise ValueError("Unknown scenario requested")
    for case in config["scenarios"]:
        name = case["name"]
        if operations and name not in operations:
            continue
        if not case["enabled"]:
            report["locked"].append(name)
            continue
        samples, phases, sizes, hashes = [], {}, [], []
        row = {"status": "fail"}
        try:
            for iteration in range(repeat):
                req = Request(
                    url + case["path"],
                    json.dumps(case["payload"]).encode(),
                    {"Content-Type": "application/json", "Accept-Encoding": "gzip"},
                )
                started = perf_counter()
                with urlopen(req, timeout=125) as response:
                    wire = response.read()
                    body = (
                        gzip.decompress(wire)
                        if response.headers.get("Content-Encoding") == "gzip"
                        else wire
                    )
                    result = json.loads(body)
                    if not result.get("candidates") or not result.get("counts", {}).get(
                        "region"
                    ):
                        raise ValueError("Scenario did not complete with candidates")
                    samples.append(perf_counter() - started)
                    sizes.append(len(wire))
                    hashes.append(
                        hashlib.sha256(
                            json.dumps(result, sort_keys=True).encode()
                        ).hexdigest()
                    )
                    for item in response.headers.get("Server-Timing", "").split(","):
                        if ";dur=" in item:
                            phase, duration = item.strip().split(";dur=")
                            phases.setdefault(phase, []).append(float(duration) / 1000)
                    if result_dir is not None and iteration == repeat - 1:
                        destination = Path(result_dir)
                        destination.mkdir(parents=True, exist_ok=True)
                        # Scenario names are configuration data, never arbitrary paths.
                        filename = hashlib.sha256(name.encode()).hexdigest()[:16] + ".json"
                        (destination / filename).write_bytes(body)
                        row["result_path"] = str(destination / filename)
            p95 = percentile(samples, 0.95)
            limit = case[
                "budget_seconds" if budget == "final" else "step6_budget_seconds"
            ]
            prior = previous["operations"].get(name) if previous else None
            if previous and (not prior or prior.get("completed") != previous["repeat"]):
                raise ValueError("Baseline lacks completed scenario")
            stable = len(set(hashes)) == 1 and (
                not prior or hashes[0] == prior["result_sha256"]
            )
            row.update(
                status="pass"
                if stable
                and p95 <= limit
                and (not prior or p95 <= prior["p95_seconds"] * 1.2)
                else "fail",
                seconds=samples,
                p50_seconds=statistics.median(samples),
                p95_seconds=p95,
                completed=len(samples),
                budget_seconds=limit,
                max_wire_bytes=max(sizes),
                result_sha256=hashes[0],
                stable_results=stable,
                phases={
                    k: {
                        "p50_seconds": statistics.median(v),
                        "p95_seconds": percentile(v, 0.95),
                    }
                    for k, v in phases.items()
                },
            )
        except (OSError, ValueError, KeyError) as exc:
            row.update(error=str(exc), completed=len(samples), seconds=samples)
        report["operations"][name] = row
        print(json.dumps({"operation": name, **row}), flush=True)
    report["passed"] = bool(report["operations"]) and all(
        row["status"] == "pass" for row in report["operations"].values()
    )
    report["all_tiers_unlocked"] = not report["locked"]
    report["qualified"] = (
        report["passed"]
        and not report["locked"]
        and repeat >= 20
        and not operations
        and previous is not None
    )
    return report
