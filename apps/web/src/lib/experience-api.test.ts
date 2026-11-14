import { afterEach, expect, it, vi } from "vitest";
import { getHistoricReplay } from "./experience-api";

afterEach(() => vi.unstubAllGlobals());

it("keeps the live landing-day and mission-window timelines separate", async () => {
  const timeline = [{ time_utc: "1969-11-19T06:54:36Z", sun_elevation_deg: 5.1485, earth_elevation_deg: 42.2 }];
  const missionTimeline = [{ time_utc: "1969-11-20T06:54:36Z", sun_elevation_deg: 17.29, earth_elevation_deg: 44.1 }];
  const fetch = vi.fn().mockResolvedValue(Response.json({ landing_utc: timeline[0].time_utc,
    landing_day: { timeline }, mission_window: { timeline: missionTimeline } }));
  vi.stubGlobal("fetch", fetch);
  expect(await getHistoricReplay("apollo-12", new AbortController().signal)).toEqual({
    landing_utc: timeline[0].time_utc, timeline, missionTimeline,
  });
  expect(fetch.mock.calls[0][1].method).toBe("POST");
});
