# Lumen · NASA Space Apps project page

**Challenge:** [CLPS Lunar Mission Browser](https://www.spaceappschallenge.org/2026/challenges/clps-lunar-mission-browser/)

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
| Assess power-generation potential | Solar elevation and longest night available on the current backend. Estimated power and energy charts require the Track A power response. |
| Assess direct-to-Earth communication windows | Earth-in-view strips, sampled Earthset, and scenario metrics. A link budget is outside the model. |
| Serve planners, educators, and the public | Audience switch, tour, glossary, and scientific details |

## Rehearsal and usability checks

- Ask each of three people outside the team to complete the tasks without hints. Record completion, time, and what confused them. The target is under 60 seconds per task.
- Ask which of two sites keeps Earth in view longer during the selected week.
- Ask when the Sun next sets for a Shackleton ridge scenario starting October 5, 2028. Verify that the chosen point and window have a sunset before using this task.
- Ask how to recover a failed mission. Use a case with a returned alternative for this test.
- Record the demo from real results. The synthetic frontend fixture is useful for checking controls as the shared API is integrated.

## Local verification

Set `VITE_LUMEN_MOCK=1` for a synthetic example of the upcoming analysis, power, event, curated-place, and replay responses. The planner still uses the current API for terrain and coverage. The official Track A fixture and independent verifier are pending integration. Scenario metrics carry `data-metric` and `data-raw` for display-parity checks.

For a synchronous production-style build, run `python scripts/track_c_smoke.py --url <base-url> --output ui-dump.json` after installing Playwright and Chromium. It compares what the board displays with the actual search response. The independent verifier is a separate integration gate.
