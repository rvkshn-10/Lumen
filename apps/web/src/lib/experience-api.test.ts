import { afterEach, expect, it, vi } from "vitest";
import { getHistoricReplay } from "./experience-api";

afterEach(() => vi.unstubAllGlobals());

it("adapts the live replay's landing-day window without inventing a flat response", async () => {
  const timeline = [{ time_utc: "1969-11-19T06:54:36Z", sun_elevation_deg: 5.1485 }];
  const fetch = vi.fn().mockResolvedValue(Response.json({ landing_utc: timeline[0].time_utc,
    landing_day: { timeline }, mission_window: { timeline: [] } }));
  vi.stubGlobal("fetch", fetch);
  expect(await getHistoricReplay("apollo-12", new AbortController().signal)).toEqual({
    landing_utc: timeline[0].time_utc, timeline,
  });
  expect(fetch.mock.calls[0][1].method).toBe("POST");
});
