# Lumen against the Space Apps judging rubric

This is a team assessment of the public deployment before the Track C and OpenVINO changes. The local judging slide assigns 0–10 points per category. The public build was serving the two-site shortlist and the API advertised 103,996 prepared evaluation points between 87°S and 90°S.

| Criterion | Score | Evidence and next step |
| --- | ---: | --- |
| Impact | 7/10 | The app gives educators and early mission planners a practical way to screen lunar sites. Show what decision changes, and time three first-time users comparing two sites. |
| Creativity | 7/10 | Ranked terrain-aware tradeoffs and interactive 3D help people explore the result. The aligned comparison and a tested model for checking near-horizon cases make the approach easier to distinguish from a 3D map alone. |
| Validity | 9/10 | The engine uses NASA LOLA elevation products and JPL ephemerides, records assumptions, and exports results. Show an independent check and explain the effect of terrain and five-minute sample spacing. |
| Relevance | 8/10 | The site and date comparison addresses the challenge directly. Earth visibility is a geometric opportunity. The current deployment does not estimate communications reliability or deliverable electrical power. |
| Presentation | 6/10 | The 3D view is clear, but on the public build the planning decision comes after several setup steps. Lead with the demo comparison and use a recording or exported comparison table as backup. |
| **Total** | **37/50** | An end-to-end demonstration of Track C could reasonably add two presentation points and one relevance point. Re-score after rehearsal. |

Sources: [Official challenge](https://www.spaceappschallenge.org/2026/challenges/clps-lunar-mission-browser/), [Lumen](https://lumenmissionplanner.earth/), [NASA LOLA lunar south pole products](https://pgda.gsfc.nasa.gov/products/90), [JPL NAIF kernels](https://naif.jpl.nasa.gov/naif/data_generic.html), [independent verifier PR](https://github.com/rvkshn-10/Lumen/pull/2).

## Rehearsed comparison

Open **Open the demo comparison** on the Pick page of the demo build. Both points use October 5–12, 2028 UTC. These are prepared LOLA grid points, not designated landing targets.

| Site | Coordinates | Time in sunlight | Earth in view | Longest Earth blackout | Earth drops below the modeled horizon, October 9 UTC |
| --- | --- | ---: | ---: | ---: | ---: |
| A (`lola--27000--79500`) | 87.23172° S, 161.24135° W | 100.0% | 69.7% | 50.8 h | 21:06:34 |
| B (`lola--29000--76500`) | 87.30250° S, 159.23904° W | 100.0% | 61.4% | 64.8 h | 07:05:56 |

These results came from the hosted site-analysis API, using a 5 km circle centered at 87.2671° S, 160.2402° W and a maximum slope of 10°. Refined transitions are model estimates with a 37.5-second bracket in this run. They also depend on the underlying terrain resolution. The 500 m spacing describes where we evaluate candidate points, and does not describe terrain accuracy.

- **Opening line:** “These two sites have sunlight for the whole week. This site keeps Earth above the local horizon for 14 hours longer. A nearby ridge can change which site you would study first.”
- **Change only the date:** Duplicate Site B for October 12–19, 2028 UTC. Its sunlight falls to 66.3%, with the final 56.7 hours in darkness. Its Sun drops below the terrain on October 16 at 15:15 UTC. That later week has no Earth view at either point.
- **Show the technology:** Open Site A or B’s **Charts**. If the OpenVINO runtime is enabled, point to the input geometry, the validated prediction task and the measured hardware and timings. The physics result remains the source of the reported visibility window.
- **Show the evidence:** Explain that Lumen computes the Sun’s and Earth’s apparent positions with JPL ephemerides and compares them with terrain horizons from NASA LOLA. Earth above the horizon is a geometric prerequisite for direct communication. A mission would still need a radio-link budget and a landing-safety assessment.

Keep the live demo to the two point analyses and preload them before presenting. In testing, a full-cap search exceeded 26 seconds and concurrent search requests returned HTTP 429. Keep a local recording or exported board available for the 30-second pitch.

Use the project page to identify what the team built during the event and credit the pre-existing planner and outside dependencies. [2026 event and submission guidance](https://www.spaceappschallenge.org/2026/), [participation terms](https://www.spaceappschallenge.org/legal/).


## CLPS Lunar Mission Browser features

1. **Launch-slip comparison.** Open **Compare launch slips** from a scenario row, then analyze the original date and starts 24 and 72 hours later. The comparison holds site, duration and mission constraints fixed. Load, battery capacity, starting charge, and Earth clearance can be changed for all three dates together. Add an evaluated date to the board to inspect it in detail.
2. **Powered contact windows.** The comparison board aligns solar generation, battery reserve, Earth clearance and powered contact on one UTC timeline. The check uses the native science samples, clips at the first modeled battery outage, and assumes no restart. The Earth flag is geometric and does not predict link performance. The charge and solar traces are display samples.
3. **CLPS mission browser.** Open **Browse lunar places → CLPS missions** for IM-1, IM-2 and Blue Ghost Mission 1. Each card links to NASA payload and landing information. The modeled touchdown and 14-day Sun and Earth replays use a flat horizon. These sites lie outside the detailed 87°S–90°S cap.
4. **Terrain cutoff evidence.** Select an Earthset or sunset marker on the aligned timeline, or inspect the event from its scenario row. Lumen shows the estimated transition, the last visible and first blocked samples, and the available bearing, range and approximate coordinates of the modeled blocker. The diagram shows angle relative to the horizon.

The [full challenge brief reproduced by HackAthlone](https://hackathlone.com/challenges/lunar-landing-site-navigator) calls out schedule changes and rapid comparison. NASA provides [CLPS mission and payload details](https://science.nasa.gov/lunar-science/clps-deliveries/) and the [observed landing coordinates](https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_artifact_impacts.html).
