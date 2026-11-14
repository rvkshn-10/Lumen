import { describe, expect, it } from "vitest";
import { cutoffTerrainEvidence } from "./cutoff-terrain";
import type { Candidate, TimeSample } from "./types";

const start = Date.parse("2028-10-09T07:05:00Z");
const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
const sample = (minute: number, visible: boolean): TimeSample => ({
  time_utc: at(minute),
  earth_azimuth_deg: 359,
  earth_elevation_deg: visible ? 1.3 : .95,
  earth_horizon_deg: 1,
  earth_visible: visible,
  sun_azimuth_deg: 90,
  sun_elevation_deg: visible ? -.2 : -.3,
  sun_horizon_deg: 0,
  sun_visible: visible,
  solar_fraction: visible ? .06 : 0,
  sun_distance_km: 149_597_870.7,
});
const site: Pick<Candidate, "horizon" | "timeline"> = {
  timeline: [sample(0, true), sample(5, false), sample(10, false)],
  horizon: [
    { azimuth_deg: 0, elevation_deg: 1, distance_m: 2_000 },
    { azimuth_deg: 90, elevation_deg: 0, distance_m: 1400 },
    { azimuth_deg: 180, elevation_deg: -.2, distance_m: 4500 },
    { azimuth_deg: 270, elevation_deg: .25, distance_m: 100 },
  ],
};

describe("cutoff terrain evidence", () => {
  it("uses the blocked sample and the higher neighbor across north", () => {
    const evidence = cutoffTerrainEvidence(site, "earthset", at(2));
    expect(evidence?.before.time_utc).toBe(at(0));
    expect(evidence?.after.time_utc).toBe(at(5));
    expect(evidence?.blockedElevation.azimuth).toBe(359);
    expect(evidence?.blocker).toEqual({ azimuth_deg: 0, elevation_deg: 1, distance_m: 2_000 });
  });

  it("finds the same bracket when the event equals the first blocked sample", () => {
    expect(cutoffTerrainEvidence(site, "earthset", at(5))?.before.time_utc).toBe(at(0));
  });

  it("uses the Sun's upper limb when the sample has a distance", () => {
    const evidence = cutoffTerrainEvidence(site, "sunset", at(2));
    expect(evidence?.visibleElevation.upperLimb).toBeCloseTo(.066, 2);
    expect(evidence?.blockedElevation.upperLimb).toBeCloseTo(-.034, 2);
    expect(evidence?.blocker?.azimuth_deg).toBe(90);
  });

  it("reports the samples when there is no matching terrain blocker", () => {
    const coarse = cutoffTerrainEvidence({ ...site, horizon: [] }, "earthset", at(2));
    expect(coarse?.after.time_utc).toBe(at(5));
    expect(coarse?.blocker).toBeNull();
    const inconsistent = cutoffTerrainEvidence({ ...site, horizon: site.horizon.slice(1) }, "earthset", at(2));
    expect(inconsistent?.blocker).toBeNull();
  });

  it("does not associate unsupported event times with a sample or blocker", () => {
    expect(cutoffTerrainEvidence(site, "earthset", at(-5))).toBeNull();
    expect(cutoffTerrainEvidence(site, "earthset", at(7))).toBeNull();
    expect(cutoffTerrainEvidence(site, "earthset", "unknown")).toBeNull();
  });
});
