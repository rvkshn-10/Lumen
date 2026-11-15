# Detailed local searches across the southern hemisphere

The existing candidate-search endpoint now routes circles north of 87 degrees
south to a LOLA terrain provider. Circles in the polar cap keep the prepared polar
products. Limits remain a 5 km radius and seven days. This enables local detailed
searches throughout the south; the full-region selector still refers to the
prepared polar-cap demo, not a simultaneous ranking of the entire hemisphere.

## Terrain source and installation

NASA PDS LOLA LDEM V3.0 at 256 pixels/degree supplies the southern hemisphere.
The source is little-endian float32 elevation in kilometres above a 1737.4 km
sphere in the DE421 mean-Earth/polar-axis frame. A 7.5-degree northern buffer
supports horizon rays crossing the equator. Installed files occupy about 9.2 GB;
resumable download chunks temporarily need another 8.5 GB.

```text
python scripts/data/download_hemisphere_lola.py
python scripts/data/install_hemisphere_lola.py
python scripts/hemisphere_detailed_smoke.py
```

The downloader requires curl and checks each response's byte range and length.
The installer scans all heights for invalid values, hashes the source files and
publishes the manifest last. Source files remain outside Git. Set
`LUMEN_HEMISPHERE_ROOT` to use an installed directory elsewhere. Runtime verifies
the manifest and file hashes before advertising `hemisphere_detailed: true` in
coverage. Missing or corrupt sources keep detailed hemisphere coverage disabled.
Existing polar and coarse exploration remain available without these files.

Deployments must install/mount this directory as well as the code. The existing
Docker image does not silently download another 9.2 GB during every build. Mount
the verified directory and set `LUMEN_HEMISPHERE_ROOT` to its container path to
enable this feature there. Local installation does not publish a hosted update.

## Calculations

- Candidates: 500 m lattice in local east/north metres; spherical destinations
  determine latitude/longitude. Candidates north of the equator and the exact pole
  are excluded. Circles crossing the equator return partial coverage.
- Elevation: bilinear pixel-centre sampling with periodic longitude and continuous
  sampling across the two longitude tiles and the equator.
- Slope: central differences over a 500 m baseline.
- Roughness: RMS residual from a least-squares plane fit to a 3x3 height grid over
  a 500 m footprint. This differs from the published polar product's definition.
- Horizon: great-circle rays, 5-degree azimuth bins; about 118 m radial sampling
  to 20 km and 472 m sampling to 200 km. Missing values fail the calculation.
- Timing: existing five-minute ephemerides, finite solar-disk geometry, visibility,
  power/event outputs and mission constraints.
- Scores: separate fixed hemisphere bounds (slope 0–30 degrees, roughness 0–100 m,
  elevation -9000–9000 m). Scores are planning preferences, not a landing-safety
  assessment, and are not calibrated to polar scores. Source heights may be
  interpolated; the nominal 118 m spacing does not establish that resolution of
  independent observations or resolve small hazards.

PSR and named-feature proximity constraints are unavailable in this provider and
are rejected rather than assigned invented distances. The normal circle selector,
site inspection, scenario windows, local terrain mesh and scientific exports work
with generated site IDs. Full-hemisphere simultaneous ranking is a separate scale
of operation and is not represented by the local search control.

Whole-hemisphere ranking is now available through a separate regional survey
selector. See [the survey guide](hemisphere-survey.md) for coverage and refinement.

## Verification

Unit tests cover southern bounds, limits, longitude wrapping, equator clipping,
kilometre-to-metre conversion, flat-sphere analytic horizons, and complete search
outputs. The smoke script checks downloaded source pixels against the earlier
independent byte-range probe, searches near-side/far-side/high-latitude/equatorial
locations, checks fixed-site inspection consistency, and exports scientific JSON
for `scripts/verify/lumen_verify.py`.

Local installation and initial verification completed successfully. Real 1 km,
one-day searches plus fixed-site inspection completed at near-side, far-side,
80-degree-south and equatorial locations in roughly 5–16 seconds after source
verification. The independent scientific verifier passed 146 checks on the
exported results. Initial coverage verification read/hashes the installed source
and took about 43 seconds on this Windows machine. These are functional smoke
measurements, not P95 performance qualification or hosted deployment evidence.

The real HTTP 5 km / seven-day search returned all 317 lattice candidates and
five shortlisted sites in 110.5 seconds including cold verification. Independent
verification of that response passed another 97 checks. This is below the
two-minute watchdog but exceeds the latency target. Hemisphere searches now
reuse the killable worker by default to retain source verification and prepared
areas; `LUMEN_REUSE_WORKER=0` restores one process per request. Source revisions,
timeout, cancellation and disconnect discard the reused worker.

Final regression results: 150 backend tests passed (one inapplicable case
skipped), 67 frontend tests passed, TypeScript/production build passed, and Ruff
and diff whitespace checks passed. Source checksums are pinned in
`scripts/data/source_catalog.json` for repeat installations.
