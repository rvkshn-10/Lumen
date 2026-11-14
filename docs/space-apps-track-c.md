# Lumen · NASA Space Apps project page

**Challenge:** [Lunar Landing Site Navigator](https://www.spaceappschallenge.org/2026/challenges/lunar-landing-site-navigator/)

## Project description

Choosing where and when to land near the lunar south pole involves trade-offs between sunlight, a clear view of Earth, and local terrain. Lumen helps the public, educators, and mission planners see those trade-offs using a 3D Moon and side-by-side comparisons.

Pick a prepared polar area and set a mission window. Compare up to four site-and-date scenarios on one timeline, then duplicate a site to try a different date. The scenario board shows the share of time in sunlight or with Earth in view, the longest stretch of darkness, and estimated sunset and Earthset when those transitions occur within the window. A solar elevation chart shows how high the Sun sits relative to the terrain. The battery check estimates how long usable capacity will last at a user-specified constant load.

Lumen uses [NASA lunar topography](https://pgda.gsfc.nasa.gov/products/90) and [JPL ephemeris kernels](https://naif.jpl.nasa.gov/naif/data_generic.html). Detailed analysis is limited to the prepared lunar south polar region. Earth visibility is a geometric indicator. Users can inspect assumptions and source data in the scientific details.

## 30-second demo

| Time | On screen | Narration |
| --- | --- | --- |
| 0–5 s | Rotate the Moon to the south pole and choose a prepared area. | “Near the Moon’s south pole, the terrain can hide the Sun and Earth.” |
| 5–11 s | Set a week-long mission and open the scenario board. | “Pick an area and dates. Lumen shows how long each candidate can see sunlight and Earth.” |
| 11–19 s | Select two rows and scrub the shared visibility strips. | “Compare two sites at the same moment to see when they lose sunlight or Earth view.” |
| 19–25 s | Open the solar elevation chart and point to the terrain horizon and battery check. | “See the Sun above the local skyline and check how long your battery would last at a constant load.” |
| 25–30 s | Duplicate a row and choose a new start. | “Try a different date to find a better window.” |

## Challenge mapping

| Requirement | Demonstrate in Lumen |
| --- | --- |
| Compare sites and dates quickly | Scenario board, duplicate a date, sort results, four-scenario selection |
| Visualize the Sun and Earth relative to the horizon | Solar elevation chart, Sun and Earth visibility strips, per-site terrain and sky evidence |
| Assess power-generation potential | Solar elevation, vertical-tracking and horizontal panel power, integrated energy, and a constant-load battery check from the Track A response. |
| Assess direct-to-Earth communication windows | Earth-in-view strips, sampled Earthset, and scenario metrics. A link budget is outside the model. |
| Serve planners, educators, and the public | Audience switch, tour, glossary, and scientific details |

## Rehearsal and usability checks

- Ask each of three people outside the team to complete the tasks without hints. Record completion, time, and what confused them. The target is under 60 seconds per task.
- Ask which of two sites keeps Earth in view longer during the selected week.
- Ask when the Sun next sets for a Shackleton ridge scenario starting October 5, 2028. Verify that the chosen point and window have a sunset before using this task.
- Ask how to recover a failed mission. Use a case with a returned alternative for this test.
- Record the demo from real results. The synthetic frontend fixture is useful for checking controls as the shared API is integrated.

## Local verification

The V2 tracks and independent verifier are integrated. Scenario metrics carry `data-metric` and `data-raw` for display-parity checks. The comparison clock drives all selected terrain pins; only scenarios covering that time appear in the scene. Date-changed scenarios retain failed-constraint evidence and suggested alternatives.

After installing Playwright and Chrome, building the frontend, and starting the API with prepared datasets, run:

```powershell
python scripts/v2_integration_smoke.py --url http://127.0.0.1:8000
python scripts/verify/lumen_verify.py --result data/cache/v2-integration/analysis.json --scene-dump data/cache/v2-integration/scene.json --ui-dump data/cache/v2-integration/ui.json --cache data/cache/track-a/cap-temporal.npz --iterate 2 --report data/cache/v2-integration/verification
```

The browser pass uses live science responses to exercise four-site terrain, ten compare-clock positions, date duplication, mobile controls, and Apollo 12 replay. It exports real analysis, UI and scene inputs plus desktop/mobile screenshots to `data/cache/v2-integration/`. The independent checker passed **111 checks, 0 failures, 0 skips**, including all 16 displayed metrics and 50 scene samples. The merged frontend has **67 passing tests**. GitHub CI also checks the API, frontend and production Docker image.

`scripts/track_c_smoke.py` remains available for a board-only display check. Set `VITE_LUMEN_MOCK=1` only for synthetic control demonstrations; release validation uses the live API. The three-person usability rehearsal and demo recording remain manual tasks.
