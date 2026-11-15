# Search performance qualification

The public limits remain **5 km / 7 days**. No larger tier is qualified. The
reference NumPy kernel is still the default. This change supplies instrumentation,
response optimizations, optional mapped tile derivatives, exact multi-window
precomputation, an experimental compiled/coarse kernel, and speed gates. It does
not claim that the plan's final latency budgets have been achieved.

## Reproduce

Use the project's Python environment with `pip install -e "backend[dev]"`.
Optional extras are `backend[profiling]` for ITT and `backend[performance]` for
Numba. Install VTune separately on the profiling machine. ITT is not required
for normal operation. See the official [ITT Python API](https://pypi.org/project/ittapi/)
and [Numba parallel execution documentation](https://numba.readthedocs.io/en/stable/user/parallel.html).

Start the API, then run:

```text
python -m uvicorn app.main:app --app-dir backend
python scripts/benchmark_completed_searches.py --scenarios scripts/bench/scenarios.json --repeat 20
python scripts/verify/lumen_verify.py --suites speed --speed-repeat 20 --speed-baseline bench/MACHINE/baseline.json
```

The benchmark includes fresh worker startup, worker transport, response encoding,
gzip transfer and client decoding. `Server-Timing` reports worker phases and API
encoding, not transport or process startup. First-call costs are included. The
scenario runner records P50 and nearest-rank P95, wire bytes, decoded-result hashes,
phase timings, machine identity and the scenario-file digest. HTTP errors and
empty results fail. A supplied baseline must match machine, scenarios and budget;
either a >20% P95 regression or a changed decoded result fails.

Locked scenarios are reported, never counted as fast results. The verifier's speed
suite fails while any are locked or fewer than 20 repetitions are requested.
`--budget step6` selects the intermediate budgets; the default uses final budgets.
Five-run files are diagnostic measurements, not P95 release qualification.

For VTune, run the same benchmark with user-task collection enabled and follow
child processes so worker tasks are captured. Neither VTune nor a Mac is available
in this workspace. Do not infer either machine's qualification from these files.

## Local baseline

`intel-i5-1235u/before.json` records five requests per supported scenario on the
Intel i5-1235U. Other validation work overlapped part of this diagnostic run;
variance is high. Repeat in an otherwise idle environment before making a speed
claim or approving a tier. Top five phases by median time:

| Scenario | Phases, descending |
| --- | --- |
| Detailed 5 km / 7 days | cached metrics, validation, body positions, shortlist details, JSON encoding |
| Cached full cap | cached metrics, area loading, category scores, body positions, map sampling |

`intel-i5-1235u/after.json` uses the default reference kernel, gzip level 1 and
orjson, without prepared mmap derivatives. Decoded response hashes match the
baseline for both scenarios. No concurrent test process ran during this second
benchmark, but the host's wall times remain variable.

| Scenario | Before P50 / P95 (s) | After P50 / P95 (s) | Before / after wire bytes |
| --- | ---: | ---: | ---: |
| Detailed 5 km / 7 days | 6.26 / 15.01 | 7.03 / 8.55 | 4,155,020 / 688,299 |
| Cached full cap | 18.02 / 50.59 | 33.92 / 36.55 | 18,929,466 / 3,243,241 |

Median JSON encoding fell from 0.160 to 0.025 seconds for detailed search and
0.623 to 0.143 seconds for the full cap. End-to-end median latency did not improve.
Both final latency targets remain unmet; full-cap wire size also exceeds 2 MB.
The speed gate correctly fails. These numbers do not authorize any tier increase.

The full-cap baseline misses even its intermediate one-second budget. The
unmeasured regional 2 km tier has no prepared data in this release; its target
scenario stays locked rather than silently benchmarking the 500 m tier.

## Optional paths

```text
python scripts/data/prepare_mapped_tiles.py --root data/derived/lunar-south-cap-v1
python scripts/data/precompute_mission_windows.py --root data/derived/lunar-south-cap-v1 --kernel-root data/raw/kernels --start 2028-10-01T00:00:00Z --months 24 --region -89.9 0 50
```

Mapped derivatives preserve original release files. Their manifest pins the source
archive hash and every NPY column checksum. Missing/stale/damaged derivatives fall
back to the verified archive. Current first-load verification still reads all
column bytes; mmap is not a claim of zero-I/O loading. The resident-byte budget
includes sorted spatial indices. Circle lookup uses an x-index, a conservative
projected box, and the original exact spherical distance check.
Temporal cache membership checks use verified ID-only reads, avoiding a second
decompression of full terrain/horizon arrays.

Window generation resumes verified per-tile work. Cache lookup accepts only exact
UTC start/end matches with matching artifacts, algorithm and kernels. Missing
optional window tiles are computed live. The existing full-cap demo remains
fail-closed if its required cache is missing. Aggregated 30-day columns cannot
answer a subwindow exactly. Float64 remains necessary for existing 1e-9 fraction
tolerances; no float32 conversion is enabled. A two-year cache is not generated
automatically: choose actual mission regions/windows before running the command.

Set `LUMEN_TEMPORAL_KERNEL=compiled` to benchmark the experimental kernel. Normal
execution does not import Numba. Compilation/import failures fall back to NumPy.
The kernel uses float64 observer subtraction and direction math; no fast-math.
It bounds each 12-sample block using the maximum actual ephemeris-vector movement,
a geometric angular cone, and conservative horizon extrema. Ambiguous blocks and
partial disks evaluate every sample. Numerical boundaries use the reference.
NumPy still reduces run lengths. Keep this opt-in until real 1,000-window science
qualification, eight-core scaling, Intel/Mac end-to-end gates and two weeks of
regression evidence are complete. The tests include random sites and a planted
underestimated-motion bound; these do not replace real mission-window validation.

Set `LUMEN_REUSE_WORKER=1` to retain a single search worker between requests.
Cancellation, disconnects and timeouts kill it; the next request starts a fresh
worker. Terrain/kernel file revisions restart it before cached science is reused.
Other operation types retain their existing process lifecycle. The mode remains
opt-in pending target-machine qualification. Scalar terrain and temporal columns
each have a 32 MiB resident budget; full horizons are loaded for shortlisted sites.
Cached temporal columns are read-only and invalidated when their files change.
Ranking and map sampling use arrays while preserving scalar scores and order.

Mapped tiles now require `LUMEN_MMAP_TILES=1`. The Windows diagnostic run regressed
loading after conversion, so their presence does not automatically enable them.
`after-vector-ranking.json` records that regression. `reused-worker.json` records
five requests with worker reuse: local P50 1.56 s, full-cap P50 15.84 s, with
unchanged decoded hashes. `retained-columns.json` records 20 requests after scalar
terrain loading and retained temporal columns: local P95 1.99 s, full-cap P95
23.77 s. Both hashes still match the original baseline. The full-cap one-second
budget remains unmet. The cold local request took 5.86 s; nearest-rank P95 at 20
samples excludes the single slowest request, which remains visible in the report.

The final column-based implementation is measured in `columnar-final.json`.
Both decoded hashes still match the original baseline. This five-run diagnostic
failed the speed gates: local P50/P95 5.62/22.95 s; full cap 12.27/51.18 s.
The last two warm full-cap requests took 7.11 and 7.40 s. Host variance prevents
a reliable speed claim; repeat qualification on an idle target machine. No
experimental worker or mmap path has been enabled by default.

## Remaining release work

- Install VTune and capture Hotspots/Threading reports; obtain the Mac baseline.
- Measure mmap conversion and region indexing on a real million-site release.
- Qualify the compiled/coarse path on real mission windows and boundary cases;
  move remaining reductions into compiled code only if profiling warrants it.
- Prepare the approved curated regions/windows and a real 2 km regional dataset.
- Reach the advertised budgets before updating the central tier table and enabling
  the corresponding benchmark scenarios. API coverage already supplies UI limits.
- Keep each optimization's qualification in a separate reviewed PR as requested
  by the plan; no PRs or merges were created here.

## Validation in this workspace

- Full backend run: 120 passed; later targeted coverage for the final loading,
  cache, profiling, numerical and speed-gate changes: 22 passed.
- Independent scientific verifier: 58 passed, 0 failed, 1 skipped.
- `python -m ruff check backend scripts` and `git diff --check`: clean.
- CI now includes synthetic compiled/reference equivalence checks on Linux,
  macOS and Windows. Remote CI has not run as part of this workspace session.
- Final column-based terrain/cache/ranking coverage: 32 passed; additional exact
  scalar-ranking and lazy-cache checks: 5 passed. Worker lifecycle checks: 11
  passed, 1 inapplicable single-use case skipped; source revision checks: 2 passed.
- Independent verification of exported API responses: 187 passed, 0 failed,
  0 skipped. Final exported responses have the same decoded hashes.
