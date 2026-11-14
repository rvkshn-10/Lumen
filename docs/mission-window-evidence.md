# Evidence behind the mission window check

The scenario board checks a minimum continuous duration against Sun visibility, Earth visibility, or their overlap. Optional margins use the existing geometry timeline to require a minimum visible fraction of the solar disk and extra Earth-center clearance above the terrain. Results show the duration, how far it is above or below the requirement, and the start and end in UTC. The CSV preserves those inputs, the site coordinates and model method. A chart lets users inspect the exact terrain and geometry at a timeline sample.

## Reproduce the demo

Open the demo comparison with both points selected. Use October 5–12, 2028 UTC. [Coordinates and original analyses](space-apps-evaluation.md)

| Check | Site A | Site B |
| --- | --- | --- |
| 110 continuous hours of Earth view | Meets the requirement | Falls short |
| 72 hours of Sunlight and Earth in view, geometric margins disabled | Meets the requirement | Meets the requirement |
| Same 72-hour check, at least 80% visible solar disk and Earth more than 1° above terrain | Meets it, 87h 45m | Falls short, 56h 05m |

Inspect October 9 at 12:00 UTC. Earth’s center is 0.513° above the modeled terrain at Site A and 0.265° below it at Site B. The model computes geometrical line of sight. Radio performance and electrical power need additional engineering inputs.

The ordinary visibility check uses refined transition intervals where the site-analysis API supplies them. Margin checks use the five-minute science samples and the sample at the start of each interval. Transitions between samples can change the actual interval length. A boundary sample in the inspector may sit just before the refined time shown. Its timestamp is labeled.

## Verification and OpenVINO

For the two demo points only, an independent parser of the same JPL ephemerides reproduced Sun and Earth angles within 7.62 × 10⁻¹¹ degrees. The reference computation reproduced both labels at all 4,034 timestamps and seven aggregate window metrics per site within 3.36 × 10⁻¹⁰ in their native units. This tests the computation under shared inputs. [Verifier and fixture](https://github.com/rvkshn-10/Lumen/pull/2)

On the separate three-point fixture, the nominal clearances alone reproduced the labels at all 6,051 timestamps. The OpenVINO model differed on 17 labels. The disagreements concentrate near the horizon, and the UI links them to the corresponding measured geometry sample. This demonstrates what the approximate model would miss and how to inspect a borderline interval. [Model and reproduction instructions](openvino-horizon-review.md)

## What the improvements can prove

| Criterion | Evidence in the app | Next verification |
| --- | --- | --- |
| Impact | A user can find and export the actual window meeting their stated rule. | Time first-time users finding the qualifying site and window. Record errors as well as completion time. |
| Creativity | A requirement changes the choice even when both sites appear sunlit for the entire week. The AI review flags individual timestamps for inspection. | Repeat with changed dates and compare how the required margins move the decision. |
| Validity | Inspect a timestamp, trace it to the modeled horizon and record the input limits. The demo discloses the independent check’s scope. | Check additional sites and seasons before generalizing the results. |
| Relevance | The board compares sites and dates around the two constraints named by the challenge. | Add panel orientation and a radio-link budget only if there are defensible engineering assumptions and tests. |

[Official Lunar Landing Site Navigator challenge](https://www.spaceappschallenge.org/2026/challenges/lunar-landing-site-navigator/)

## When a selected scenario falls short

On the demo board, uncheck Site A so only Site B is selected. With a minimum of 110 continuous hours of Earth visibility, the board identifies Site A under **Other analyzed scenarios** and links to its qualifying window. Raise the minimum to 120 hours and neither analyzed scenario qualifies. The app applies the user's current requirements to the rows already on the board.

To measure impact with first-time users, give them this task without pointing out the new feature: “Site B is selected. Your operation needs 110 continuous hours of Earth visibility. Find a qualifying site and report its window in UTC.” Record the chosen site, start and end times, seconds elapsed, and whether they asked for help. Use a comparable second task if comparing versions so remembering the first answer does not drive the result.
