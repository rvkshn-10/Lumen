# V2 implementation status — November 14, 2026

Source: the user's `lumen-v2-plan.md`. Its two linked Claude artifacts could not
be retrieved. This file distinguishes the implemented V2 experience from the
separate, unfinished whole-Moon expansion.

## V2 experience

The existing merged implementation provides the four-scenario board and shared
terrain, terrain-aware sky and panorama, sight lines, power and battery tools,
refined events, alternatives, four-class suitability, curated places, historic
replay, audience settings, glossary, and sharing/export.

This follow-up completes explicit Plain and Engineer result views. They share
one scenario model, selection state, clock, event calculation and metric renderer.
Public/Educator default to Plain; Planner defaults to Engineer. Either audience
can switch views without rerunning or replacing scientific results. Plain cards
show the verdict, metrics and countdowns. Engineer adds exact numerical evidence,
applied requests, power assumptions and DTE metrics. Missing DTE results are
explicitly unavailable, never estimated from Earth visibility.

Earth-clearance margin is editable in advanced mission settings, defaults to 2°,
and is validated against the existing backend's 0–90° contract. This is a
geometric metric, separate from the existing Earth-in-view ranking and constraints.
The terrain-free scene is demoted under “Illustrative sky” with a flat-horizon
explanation. The mission-brief parser remains under advanced settings; the former
two-pin comparison is already replaced in the main workflow.

## Whole-Moon expansion: not released

The requested S1 (80–90°S / 500 m), S2 (50 km mission regions / 500 m), S3
(60–80°S / 1 km), and S4 (0–60°S / 2 km) are still planned tiers. Current
preparation scripts support the existing 87–90°S cap and the separate coarse
preview. They do not yet prepare these four tiers. No 50 km/30-day detailed or
100 km regional limits have been enabled. Source manifests, per-tier horizon and
validity recipes, verified releases, and representative performance validation
are required before those tiers can be served.

The summary's ~8.3 M/16.6 M counts and ~2.5/5 GB sizes are estimates, not measured
artifacts in this repository. Missing detailed artifact content is needed to
resolve preparation/rollout requirements rather than guessing a new science
contract. Coarse-to-fine sampling and a parallel float32 kernel remain unfinished;
this change preserves the exact existing calculations.

## Reproducible engine timing

`scripts/benchmark_search.py` now accepts an exact request, writes source-linked
JSON evidence, reports response bytes and nearest-rank P95, and exits unsuccessfully
if a requested strict threshold fails or fewer than 20 runs were measured.
For example, with a real request JSON:

```sh
.venv/bin/python scripts/benchmark_search.py --request request.json \
  --repeat 20 --p95-target 30 --output data/cache/performance.json
```

Use `--fresh-process` to reset in-process caches between runs. Verified disk caches
are retained. The timed scope is search plus JSON serialization; separate-process
startup is recorded separately. These reports do not measure HTTP queueing,
concurrency, cold disk, hosted latency or preparation throughput. A passing small
area cannot certify a hemisphere tier or justify raising public limits. Full
release gates still require scientific parity and representative service loads.

## Validation for this follow-up

- 70 frontend tests, including identical raw values in Plain and Engineer views,
  absent DTE evidence, and failed constraints in Plain view.
- 22 V2 backend science, alternatives and integration tests.
- 5 benchmark-gate tests: minimum sample count, tail handling, strict thresholds,
  and rejection of invalid measurements.
- Live local browser: mission setup → search → Plain cards → select two scenarios
  → Engineer table → Plain cards, with selection and shared terrain preserved.
- Production build and changed Python lint checks.

A 20-run, 3 km / 7-day local engine benchmark on the bundled demo measured
P95 0.129 s, maximum 0.322 s. This is only that request on this machine using
existing caches, not a whole-Moon performance claim. The machine-readable report
is in ignored `data/cache/v2-plan-review/performance.json`.
