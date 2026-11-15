import type { TimeSample } from "./types";
import { queueFetch } from "./queue-fetch";

export interface CuratedSite {
  id: string; name: string; kind: "artemis_region" | "historic" | "feature";
  latitude_deg: number; longitude_deg_east: number; landing_utc?: string;
  analysis: "detailed" | "coarse"; source_url: string; blurb: string;
}
type ReplaySample = Pick<TimeSample, "time_utc" | "sun_elevation_deg"> & Partial<Pick<TimeSample, "earth_elevation_deg" | "earth_visible" | "sun_visible">> & {
  sun_azimuth_deg?: number; earth_azimuth_deg?: number;
};

/** Elevation grid around a landing point: rows run north→south, columns west→east. */
export interface ReplayTerrain { width: number; height: number; extent_m: [number, number, number, number]; elevations_m: number[]; resolution_m: number }

export interface Replay {
  landing_utc?: string;
  timeline: ReplaySample[];
  missionTimeline?: ReplaySample[];
  terrain?: ReplayTerrain;
}

async function read<T>(path: string, signal: AbortSignal, post = false): Promise<T> {
  const response = await queueFetch(`${import.meta.env.VITE_API_BASE_URL ?? "/api/v1"}/${path}`, { signal, method: post ? "POST" : "GET" });
  if (!response.ok) throw new Error("The service could not load this data.");
  return response.json();
}

export async function getCuratedSites(signal: AbortSignal) {
  if (import.meta.env.VITE_LUMEN_MOCK === "1") {
    const { mockPlaces } = await import("./scenario-mock");
    return mockPlaces;
  }
  return (await read<{ sites: CuratedSite[] }>("curated-sites", signal)).sites;
}
// Replays are fixed per mission, so switching back to a site reuses the result.
const replayCache = new Map<string, Replay>();
export async function getHistoricReplay(id: string, signal: AbortSignal): Promise<Replay> {
  if (import.meta.env.VITE_LUMEN_MOCK === "1") {
    const { mockReplay } = await import("./scenario-mock");
    return mockReplay();
  }
  const cached = replayCache.get(id);
  if (cached) return cached;
  const result = await read<{ landing_utc: string; landing_day: Replay; mission_window?: Replay }>(
    `historic/${encodeURIComponent(id)}/replay`, signal, true);
  const replay = { landing_utc: result.landing_utc, timeline: result.landing_day.timeline,
    missionTimeline: result.mission_window?.timeline, terrain: result.landing_day.terrain };
  replayCache.set(id, replay);
  return replay;
}

/** NASA-published trajectory (NAIF PDS SPICE archive or JPL Horizons), cached by scripts/fetch_nasa_trajectories.py. */
export interface TrajectorySegment { t_ms: number[]; spacecraft_km: [number, number, number][]; moon_km: [number, number, number][] }
export interface TrajectoryDescent { t_ms: number[]; enu_km: [number, number, number][]; altitude_km: number[]; touchdown_utc: string; frame: string }
export interface Trajectory {
  id: string; name: string; frame: string; coverage: [string, string][];
  segments: TrajectorySegment[]; descent: TrajectoryDescent;
  source: { name: string; url: string; naif_id?: number; horizons_id?: string; files?: { file: string; url: string; sha256: string }[]; note?: string };
}
export type TrajectoryResult = { trajectory: Trajectory } | { trajectory: null; message: string };
const trajectoryCache = new Map<string, TrajectoryResult>();
export async function getHistoricTrajectory(id: string, signal: AbortSignal): Promise<TrajectoryResult> {
  const cached = trajectoryCache.get(id);
  if (cached) return cached;
  const response = await fetch(`${import.meta.env.VITE_API_BASE_URL ?? "/api/v1"}/historic/${encodeURIComponent(id)}/trajectory`, { signal });
  let result: TrajectoryResult;
  if (response.status === 404) {
    const body = await response.json().catch(() => ({}));
    result = { trajectory: null, message: body?.detail?.message ?? "NASA has not published a trajectory for this lander." };
  } else if (!response.ok) {
    throw new Error("The trajectory service could not load this data.");
  } else {
    result = { trajectory: await response.json() as Trajectory };
  }
  trajectoryCache.set(id, result);
  return result;
}
