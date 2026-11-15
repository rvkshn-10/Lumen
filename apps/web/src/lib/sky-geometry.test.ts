import { describe, expect, it } from "vitest";
import {
  blockerAt, groundDirection, elevationExaggeration, formatDuration, horizonAt, nextChange, sampleIndexAt,
  skyDirection, skyEvents, steadyState, suitabilityClass, visibilitySegments,
} from "./sky-geometry";
import type { TimeSample } from "./types";

const sample = (i: number, sun: boolean, earth: boolean, sunAz = i * 10): TimeSample => ({
  time_utc: new Date(Date.UTC(2028, 9, 5) + i * 300_000).toISOString(),
  sun_azimuth_deg: sunAz % 360, sun_elevation_deg: 1, earth_azimuth_deg: 90, earth_elevation_deg: 3,
  sun_horizon_deg: 0, earth_horizon_deg: 0, solar_fraction: sun ? 1 : 0, sun_visible: sun, earth_visible: earth,
});

describe("terrain-aware sky geometry", () => {
  it("keeps local east/north mesh directions independent of the selected longitude", () => {
    const crs = "Local azimuthal equidistant, east/north metres about selected center";
    for (const longitude of [-150, 45, 120]) {
      const north = groundDirection(longitude, 0, crs);
      const east = groundDirection(longitude, 90, crs);
      expect(north[0]).toBeCloseTo(0); expect(north[1]).toBeCloseTo(1);
      expect(east[0]).toBeCloseTo(1); expect(east[1]).toBeCloseTo(0);
    }
    const polarNorth = groundDirection(90, 0);
    expect(polarNorth[0]).toBeCloseTo(1); expect(polarNorth[1]).toBeCloseTo(0);
  });
  it("uses the conservative adjacent-bin maximum, periodic across north (backend rule)", () => {
    const profile = Array.from({ length: 72 }, (_, i) => i / 10);
    expect(horizonAt(profile, 0)).toBe(0.1);
    expect(horizonAt(profile, 7.5)).toBe(0.2);
    expect(horizonAt(profile, 359)).toBe(7.1);   // bin 71 vs bin 0 → 7.1
    expect(horizonAt(profile, -1)).toBe(7.1);
  });
  it("picks the blocking ray that sets the horizon", () => {
    const horizon = [{ azimuth_deg: 0, elevation_deg: 1, distance_m: 100 }, { azimuth_deg: 180, elevation_deg: 3, distance_m: 900 }];
    expect(blockerAt(horizon, 10)?.distance_m).toBe(900);
  });
  it("splits a track into visible and blocked runs that touch at each transition", () => {
    const timeline = [true, true, false, false, true].map((v, i) => sample(i, v, true));
    const runs = visibilitySegments(timeline, "sun");
    expect(runs.map(r => r.visible)).toEqual([true, false, true]);
    expect(runs[1].points[0].index).toBe(1);           // starts where the previous run ended
    expect(runs[2].points[0].index).toBe(3);
  });
  it("keeps samples on both sides of a change when thinning", () => {
    const timeline = Array.from({ length: 50 }, (_, i) => sample(i, i < 23, true));
    const [lit, dark] = visibilitySegments(timeline, "sun", { step: 10 });
    expect(lit.points.at(-1)?.index).toBe(22);
    expect(dark.points[0].index).toBe(22);
    expect(dark.points[1].index).toBe(23);
  });
  it("breaks panorama runs where the azimuth wraps through north", () => {
    const timeline = [350, 355, 2, 8].map((az, i) => sample(i, true, true, az));
    expect(visibilitySegments(timeline, "sun", { splitAtWrap: true })).toHaveLength(2);
    expect(visibilitySegments(timeline, "sun")).toHaveLength(1);
  });
  it("finds sunset and Earthset with a plain-language countdown", () => {
    const timeline = Array.from({ length: 40 }, (_, i) => sample(i, i < 30, i < 12));
    const events = skyEvents(timeline);
    expect(events.map(e => `${e.body}-${e.type}`)).toEqual(["earth-set", "sun-set"]);
    expect(nextChange(timeline, timeline[0].time_utc, "sun")?.label).toBe("Sunset in 2 h 28 min");
    expect(nextChange(timeline, timeline[0].time_utc, "earth")?.label).toBe("Earthset in 58 min");
    expect(nextChange(timeline, timeline[35].time_utc, "sun")).toBeNull();
  });
  it("describes a body that never changes during the window", () => {
    expect(steadyState([sample(0, true, false), sample(1, true, false)], "sun")).toBe("Sunlit all window");
    expect(steadyState([sample(0, true, false), sample(1, true, false)], "earth")).toBe("Earth hidden all window");
  });
  it("formats durations people can read", () => {
    expect(formatDuration(0.2)).toBe("12 min");
    expect(formatDuration(5.5)).toBe("5 h 30 min");
    expect(formatDuration(52)).toBe("2 d 4 h");
    expect(formatDuration(47.99)).toBe("2 d");
  });
  it("maps scores to the four suitability classes used by the verifier", () => {
    expect([0, 24.9, 25, 49.99, 50, 75, 100].map(suitabilityClass)).toEqual([0, 0, 1, 1, 2, 3, 3]);
    expect(suitabilityClass(Number.NaN)).toBe(-1);
  });
  it("exaggerates elevation for legibility without reordering body vs ridge", () => {
    const k = elevationExaggeration({ horizon: [{ azimuth_deg: 0, elevation_deg: 2 }], timeline: [sample(0, true, true)] });
    expect(k).toBeGreaterThan(1);
    const ridge = skyDirection(0, 2, k)[1], sun = skyDirection(0, 2.1, k)[1];
    expect(sun).toBeGreaterThan(ridge);
    const [x, y, z] = skyDirection(90, 0);
    expect(x).toBeCloseTo(1); expect(y).toBeCloseTo(0); expect(z).toBeCloseTo(0);   // east = +X
    expect(skyDirection(0, 0)[2]).toBeCloseTo(-1);                                    // north = −Z
  });
  it("finds the sample at or before a time", () => {
    const timeline = Array.from({ length: 5 }, (_, i) => sample(i, true, true));
    expect(sampleIndexAt(timeline, timeline[3].time_utc)).toBe(3);
    expect(sampleIndexAt(timeline, new Date(Date.parse(timeline[3].time_utc) + 1000).toISOString())).toBe(3);
    expect(sampleIndexAt(timeline, "2000-01-01T00:00:00Z")).toBe(0);
  });
});
