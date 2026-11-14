# Verification: `lumen-verify`

`scripts/verify/` is an independent checker for Lumen's data and results. It never
imports `backend/app`, so the app is never checked against itself.

| File | Role |
|---|---|
| `oracle_ephemeris.py` | Reads the pinned DE440 SPK and Moon PA PCK directly (DAF/Chebyshev), applies converged light time + stellar aberration (`CN+S` Sun, `XCN+S` Earth) and the PA→ME rotation. No CSPICE. Reproduces the app's az/el to ~1e-10°. |
| `reference_models.py` | The specification for derived quantities: horizon lookup, disk fraction, window metrics, scoring, **power**, **sunset/earthset events**, **suitability classes**. |
| `lumen_verify.py` | Runs the suites, the iterate loop, the baseline ratchet and the self-test. |
| `make_contract_fixture.py` | Builds `fixtures/contract-v2.json`, a full analysis response including every new v2 field, from the oracle. UI work builds against it before the backend lands. |

## Commands (repository root, project venv)

```bash
python scripts/verify/lumen_verify.py                      # all suites
python scripts/verify/lumen_verify.py --result export.json # check an exported analysis
python scripts/verify/lumen_verify.py --iterate 5          # 5 clean randomised passes, growing samples
python scripts/verify/lumen_verify.py --self-test --result scripts/verify/fixtures/contract-v2.json
python scripts/verify/lumen_verify.py --update-baseline    # after a reviewed improvement only
```

Reports go to `data/cache/verify/verify-report.{md,json}`. Exit code 1 on any failure.

## Suites

- **data**: kernel SHA-256, cap tiles (ranges, 72 bins, unique ids, 500 m grid, 103,996 sites), temporal cache sanity.
- **ephemeris**: every timeline sample's Sun/Earth azimuth and elevation vs the oracle (tol 1e-6°).
- **visibility**: horizon lookup, solar disk fraction, per-sample visible flags, all seven window metrics.
- **scoring**: criteria, weighted score, rank order, 1.5 km separation, top shortlist = best mapped point.
- **cache**: random cap sites recomputed from scratch for the cached October 2028 window.
- **metamorphic**: raising the horizon never adds light or Earth view; with no horizon the Sun is always up; disk fraction ≤ sunlit fraction; power is zero when the Sun is blocked; a horizontal panel never beats a vertical tracking panel.
- **physics**: polar elevation bounds, published Apollo 11/12/14/15/17 touchdown Sun elevations (±0.3°), Chang'e 4 never sees Earth.
- **parity** (with `--scene-dump` / `--ui-dump`): what the 3D scene draws and what the UI prints equal the API values (angles within 0.05°, blocked flags identical, numbers within display rounding). Dump formats are in the `lumen_verify.py` docstring.
- **features**: v2 contracts for power, events, alternatives, suitability classes and curated sites. These SKIP until implemented, then must pass.

## The improvement loop

1. Run `lumen_verify.py`. Failures are listed first, each with a reproduction (`repro`: result file, site id, window).
2. Fix the app (or, if the reference is wrong, change `reference_models.py` in a reviewed PR that also updates this file).
3. Re-run. `--iterate N` keeps re-running the randomised suites with new seeds and 1.5× larger samples until N passes are clean in a row.
4. The **baseline ratchet** (`scripts/verify/baseline.json`) stores the worst error seen for each check. A run fails if a check exceeds `max(tolerance, 2 × baseline)`, so accuracy can only get better.
5. `--self-test` plants known bugs (0.01° Sun error, one flipped sample, 5% power error, an event moved one hour, a colour class off by one, …) and fails if any one goes undetected. Run it whenever a check is edited.

## Tolerances

Angles 1e-6°; fractions 1e-9; hours 1e-6 h; score 1e-6 points; power relative 1e-6. Cache comparison is normalised by window length. Historic Sun elevations ±0.3° (site coordinate and definition differences).

## Known limits of the checker

The oracle shares inputs with the app (kernels, horizon profiles), so it catches *computation* errors, not DEM or kernel errors. The DEM is cross-checked separately by `scripts/data/verify_cap_reference.py`. Pre-1972 UTC uses ΔAT = 10 s (< 0.001° Sun error), which is acceptable for historic replay only.
