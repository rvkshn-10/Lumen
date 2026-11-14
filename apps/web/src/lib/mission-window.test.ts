import { describe, expect, it } from "vitest";
import { checkWindow, sampleIndexAt } from "./mission-window";
import { DEFAULT_REQUEST } from "./missions";
import { mockScenario } from "./scenario-mock";

const day = "2028-10-05T";
const time = (hour: number) => `${day}${String(hour).padStart(2, "0")}:00:00Z`;
const request = { ...DEFAULT_REQUEST, time_range: { start_utc: time(0), end_utc: time(4) } };

describe("mission window evidence", () => {
  it("intersects refined intervals and preserves their UTC boundaries", () => {
    const row = mockScenario("fixture-1", request);
    row.site.visibilityIntervals = {
      sun: [{ start_utc: time(0), end_utc: time(3), duration_hours: 3, visible: true }],
      earth: [{ start_utc: time(1), end_utc: time(4), duration_hours: 3, visible: true }],
    };
    const result = checkWindow(row, "both", 2);
    expect(result.longest).toEqual({ start: Date.parse(time(1)), end: Date.parse(time(3)) });
    expect(result).toMatchObject({ longestHours: 2, method: "Refined transitions", meets: true, marginHours: 0 });
    expect(checkWindow(row, "both", 3).meets).toBe(false);
  });

  it("uses the simultaneous sampled geometry with margins and does not bridge gaps", () => {
    const row = mockScenario("fixture-1", request);
    row.site.timeline = [0, 1, 2, 3, 4].map((hour) => ({ ...row.site.timeline[0], time_utc: time(hour),
      sun_visible: true, earth_visible: true, solar_fraction: hour === 2 ? .4 : .8, earth_horizon_deg: 0, earth_elevation_deg: hour === 1 ? 1 : 1.1 }));
    expect(checkWindow(row, "both", 3)).toMatchObject({ method: "Sampled intervals", longestHours: 4, meets: true });
    expect(checkWindow(row, "both", 3, { solarDiskPercent: 80, earthDegrees: 1 })).toMatchObject({ longestHours: 1, meets: false, marginHours: -2 });
    expect(sampleIndexAt(row.site.timeline, Date.parse(time(3)) + 1)).toBe(3);
    expect(sampleIndexAt(row.site.timeline, Date.parse(time(0)) - 1)).toBe(-1);
  });
});
