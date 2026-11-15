# Background search preparation and Intel development radii

The planner uses GitHub's four-site comparison UI through `8248d62`. Preparation
status is informational: **preparing**, **ready**, or **unavailable**. It never
disables submission. Ready means scientific data/geometry are prepared; the
mission calculation still uses the submitted area, dates, limits and preferences.

The stable default remains 5 km and seven days. The user-authorized Intel
development mode allows 10 or 15 km with `LUMEN_MAXIMUM_RADIUS_KM=10` or `15`.
It retains the 500 m candidate lattice, seven-day maximum and 120-second search
watchdog. It is explicitly experimental, without a Mac prerequisite. Larger
radii have **not** passed the release P95 performance gate. No 50/100 km tier or
dense hemisphere-wide preparation is enabled.

For this Windows workspace, build the UI and start the Intel local service with:

```powershell
./scripts/start_intel_local.ps1
# Stable limits or a comparison without speculative preparation:
./scripts/start_intel_local.ps1 -MaximumRadiusKm 5 -DisablePreparation
```

The script serves the UI and API on `http://localhost:8000`. It neither downloads
data nor installs dependencies. Installed LOLA sources, survey data and pinned
JPL kernels are required for the corresponding search capabilities. Other hosts
can use the same environment variables with their normal Uvicorn launcher.

## Execution and resource bounds

FastAPI lifespan starts optional preparation without waiting for source checks.
It reuses the existing killable search worker and scientific caches: verified
read-only LOLA maps, ephemeris kernels, the installed 827-location survey and four
local geometry entries. The startup job warms sources and the prepared regional
survey; it does not calculate a default mission or download missing data.

Area edits debounce for 800 ms. There is one current preparation and no queue of
old areas. Browser polling renews a 25-second lease; supersession, page cleanup
or an expired lease cancels speculative work. Preparation is limited to one
worker, one native calculation thread, 180 seconds and 768 MiB sampled resident
memory, including Windows launcher descendants. Its priority is lowered on
Windows. Local horizon tracing yields after each candidate, while foreground
calculations retain eight-candidate batches. Completed interrupted batches can
be resumed for an identical area. Source hashing yields at 1 MiB boundaries.

Foreground work signals cancellation of preparation and allows 350 ms for a
cooperative handoff before terminating the process tree. It then acquires the
worker before starting the calculation watchdog. The UI also attempts a bounded
preflight handoff outside its foreground deadline. Matching foreground requests
share one calculation; disconnecting one subscriber does not cancel the others.
The last subscriber's cancellation stops the calculation. A different concurrent
foreground request receives the existing explicit capacity response.

Native NumPy/CSPICE libraries initialize before the blocking control-reader
thread, avoiding a Windows DLL loader stall. Pipe readers finish before their
streams close. Worker crashes, optional startup failures and lease expiration
leave normal submission available. Shutdown terminates the complete worker tree.

## Cache identity and scientific correctness

Exact results reuse the existing checksum-verified, atomic disk cache, bounded
to 64 MiB, plus an eight-entry/64 MiB worker response LRU. Keys cover the complete
validated request and current source/code epoch. They do not round coordinates,
collapse time windows or reuse another area's results. Successful responses only
are cached, and cached objects are decoded independently for each response.

The epoch tracks terrain/catalog/feature metadata, source artifacts, survey and
global horizon artifacts, pinned kernels, Python/scientific-library versions,
all backend code, kernel mode and radius
configuration. Small JSON manifests are also content-hashed. Windows NT ChangeTime
and file identity detect artifact changes even when LastWriteTime is preserved.
Small artifacts are content-fingerprinted to cover coarse timestamp collisions.
Large terrain checksums are retained only for the exact verified file identity.

Request-start/end checks and the supervisor invalidate workers after source or
code changes. A change during calculation rejects the result instead of serving
mixed evidence. Exact disk results and optional runtime temporal caches include
the code revision. Existing prepared per-tile caches retain their own verified
calculation-code and ephemeris fingerprints. Numerical ephemeris code is unchanged,
so the installed full-cap demo remains compatible. Changed HTTP/UI code still
requires the normal application restart/rebuild.

## Intel measurements

Machine: Intel Core i5-1235U, 16 GiB RAM, Windows. These are single serial
diagnostic runs, with process-cold workers and an uncontrolled OS file cache,
not 20-run P95 qualification. Worker transport and decoding are included; the
following table does not include HTTP/gzip transfer. Measurement requests and
summary reports are under `bench/intel-search-20261115/`.

| Case | First submitted search | Exact repeat |
| --- | ---: | ---: |
| Survey, background disabled | 14.41 s | 0.55 s |
| Survey, startup preparation ready | 1.75 s | 0.81 s |
| Survey, submitted during startup | 14.98 s | 0.71 s |
| Local 1 km, background disabled | 17.62 s | 0.67 s |
| Local 1 km, submitted during preparation | 19.12 s | 0.75 s |
| Local 1 km, latest changed area ready | 0.78 s | 0.80 s |

The ready survey shifted 12.86 seconds of work before submission and reduced
submitted latency by about 88%. This is moving necessary work earlier, not
eliminating its cost. The changed local area's preparation took 28.28 seconds
after startup preparation. Early submission did **not** consistently improve
latency: a handoff can restart the worker when it cannot yield promptly, losing
uncommitted preparation and requiring verification again. Observed handoffs in
the early-submission cases were approximately 0.38 seconds. All six cases
returned identical scientific results for their matching exact request.

| Detailed radius, seven days | Locations | Geometry unprepared | Different mission window, retained geometry | Exact repeats |
| --- | ---: | ---: | ---: | ---: |
| 5 km | 317 | 9.67 s | 1.54 s | 0.44–0.45 s |
| 15 km | 2,821 | 54.38 s | 3.53 s | 0.59–0.65 s |

These radius measurements began with verified sources/kernels already retained.
The 15 km cold-geometry search peaked at approximately 269 MiB resident memory.
An independent full 15 km background preparation took 42.12 seconds, peaked at
221 MiB, and produced a complete result identical to the foreground reference.
Independent science verification of both 15 km mission windows passed 187 checks
with no failures/skips. The real HTTP polar 15 km search ranked 2,819 prepared
locations in 7.98 seconds, and the unchanged fixed full-cap demo ranked all
103,996 locations successfully. These HTTP smoke timings overlapped other QA and
are not release latency evidence.

Initial diagnostics under severe memory pressure also exposed and led to fixing
the Windows native-import ordering issue. Those timeout runs are excluded from
the comparison above. Low RAM, cold storage, startup imports, and interruption
before a checkpoint remain limitations. Warm-up alone never qualifies a larger
search tier.

## Verification and reproduction

```text
python -m pytest backend/tests
python -m ruff check backend scripts
npm run test:web
npm run build
python scripts/bench/search_warmup.py
python scripts/bench/intel_radius.py
python scripts/bench/background_radius_equivalence.py --reference PATH_FROM_RADIUS_REPORT
python scripts/preparation_ui_smoke.py
python scripts/hemisphere_ui_smoke.py
```

The browser checks use recorded scientific responses and explicit service-state
fixtures. Desktop 1440 px and mobile 390 px checks cover preparation states,
debouncing, cancellation, submission while unavailable, four-site comparison,
scope changes, dates, refinement, loaded Moon assets and actual local terrain
rendering. The independent verifier and live HTTP checks validate the installed
scientific engine separately. CI runs worker/equivalence tests on Windows and
Linux; Mac performance testing is excluded as requested.
