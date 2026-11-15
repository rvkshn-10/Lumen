import { sampleIndexAt } from "./mission-window";
import { blockerAt } from "./sky-geometry";
import type { Candidate, TimeSample } from "./types";

export type CutoffType = "sunset" | "earthset";

const SUN_RADIUS_KM = 695_700;

function bodyAt(sample: TimeSample, type: CutoffType) {
  if (type === "earthset") {
    return {
      azimuth: sample.earth_azimuth_deg,
      elevation: sample.earth_elevation_deg,
      horizon: sample.earth_horizon_deg,
      visible: sample.earth_visible,
    };
  }
  const distance = sample.sun_distance_km;
  const radius = distance && distance > SUN_RADIUS_KM
    ? Math.asin(SUN_RADIUS_KM / distance) * 180 / Math.PI
    : undefined;
  return {
    azimuth: sample.sun_azimuth_deg,
    elevation: sample.sun_elevation_deg,
    horizon: sample.sun_horizon_deg,
    visible: sample.sun_visible,
    upperLimb: radius === undefined ? undefined : sample.sun_elevation_deg + radius,
  };
}

export function cutoffTerrainEvidence(site: Pick<Candidate, "horizon" | "timeline">, type: CutoffType, timeUtc: string) {
  const instant = Date.parse(timeUtc);
  if (!Number.isFinite(instant)) return null;
  const { timeline } = site;
  const index = sampleIndexAt(timeline, instant);
  // A transition exactly at a sample may belong to either adjacent bracket.
  const beforeIndex = Date.parse(timeline[index]?.time_utc) === instant && index > 0 && !bodyAt(timeline[index], type).visible
    ? index - 1
    : index;
  const before = timeline[beforeIndex], after = timeline[beforeIndex + 1];
  if (!before || !after) return null;
  const lit = bodyAt(before, type), blocked = bodyAt(after, type);
  if (!lit.visible || blocked.visible) return null;

  const ray = blockerAt(site.horizon, blocked.azimuth);
  const distance = ray?.distance_m;
  const blocker = ray && distance != null && Number.isFinite(distance) && distance > 0 &&
    Math.abs(ray.elevation_deg - blocked.horizon) < 1e-6 ? { ...ray, distance_m: distance } : null;
  return { before, after, visibleElevation: lit, blockedElevation: blocked, blocker };
}
