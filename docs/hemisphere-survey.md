# Whole southern hemisphere ranking

Choose **Area selection → Whole southern hemisphere · regional survey** in the
planner. Select a mission window of up to seven days and ranking priorities, then
run the normal search. It ranks 827 regional locations across the south and
returns five shortlisted sites plus eligible map points. **Refine Candidate ·
5 km** opens a dense local search while preserving the mission and constraints.

The revamped planner also exposes three primary scope cards above the Moon:
**Survey the hemisphere**, **Search a local area**, and **Compare the polar cap**.
Coverage and readiness remain visible when the mobile coordinate editor is
collapsed. The mission review and exported coverage summary use the applied
scope. Refinement actions appear above the results board in the public view;
they preserve dates, priorities and required limits. Switching scopes retains
the last local selection. Scene panels stay mounted across stages to retain
camera state and avoid canvas teardown during refinement.

The mission form disables unsupported PSR/feature-distance controls for hemisphere
terrain and offers explicit removal of imported feature requirements. Review and
submission also check the current service's advertised survey/local capabilities;
changing scopes does not silently discard constraints.

`scripts/hemisphere_ui_smoke.py` exercises desktop and 390 px mobile flows with
recorded scientific responses and explicit coverage fixtures. This verifies UI
integration independently of the scientific checks described below. Screenshots
and its machine-readable report are written to `data/cache/hemisphere-ui/`.
Desktop (1440 px) and mobile (390 px) checks passed: scope selection, truthful
survey review, refinement outside advanced controls, retained dates, no horizontal
overflow and no page errors. The frontend suite passed 71 tests and the production
build passed after integration.

This is a regional survey, not an exhaustive ranking of every 500 m location.
Latitude bands run from -87.5 to -2.5 degrees, five degrees apart. The longitude
count per band is rounded from `72*cos(latitude)`, giving roughly equal-area,
approximately 150 km spacing. Boundaries are represented by their nearest bands.

Slope and roughness use installed 118 m LOLA terrain over a 500 m footprint.
Survey horizons use the verified global LOLA grid at about 1.9 km north–south
spacing, with five-degree bearings and 2 km radial steps to 200 km. Observer
elevations use that same coarse grid for consistent skyline geometry. The artifact
also stores high-resolution elevations as `terrain_elevation_m`.

The survey can miss favourable areas, narrow ridges and hazards. Local refinement
uses the full local horizon model. Scores use separate hemisphere anchors and
are not calibrated against polar-product scores. Exports record the sampling,
sources and horizon resolution. No result claims a global surface optimum.

## Preparation

After installing [hemisphere terrain](hemisphere-detailed-search.md), run:

```text
python scripts/data/prepare_global.py
python scripts/data/prepare_hemisphere_survey.py
```

Preparation resumes checksum-verified blocks scoped to model version and source
fingerprint. The final manifest is published only after all blocks are present.
Runtime checks source fingerprints, archive checksum, lattice, IDs, array shapes
and finite values. Stale/corrupt/missing data disable the selection. Coverage
advertises `hemisphere_survey: true` after verification. The archive is 0.53 MB.

The existing `POST /api/v1/candidates/search` accepts a region containing only
`{"selector_type":"southern_hemisphere"}` and the usual mission inputs. Centre
and radius are disallowed. The prepared polar-cap demo is a separate selector.
Site inspection, shifted windows and exports use the survey geometry.

## Validation

The real seven-day HTTP search ranked all 827 sites in 66.7 seconds cold and
2.3 seconds warm, with identical decoded results. Fixed-site inspection matched.
These are smoke measurements, not P95 qualification. Independent verification
passed 97 checks; targeted backend tests passed 27 checks (two inapplicable cases
skipped). Frontend tests and TypeScript/production build passed.

The survey is enabled locally. Hosted deployment also needs the installed
hemisphere data directory and survey subdirectory; this work does not deploy it.
