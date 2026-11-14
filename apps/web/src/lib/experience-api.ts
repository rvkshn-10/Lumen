import type { TimeSample } from "./types";

export interface CuratedSite {
  id: string; name: string; kind: "artemis_region" | "historic" | "feature";
  latitude_deg: number; longitude_deg_east: number; landing_utc?: string;
  analysis: "detailed" | "coarse"; source_url: string; blurb: string;
}
export interface Replay {
  landing_utc?: string;
  timeline: Pick<TimeSample, "time_utc" | "sun_elevation_deg">[];
}

async function read<T>(path: string, signal: AbortSignal, post = false): Promise<T> {
  const response = await fetch(`${import.meta.env.VITE_API_BASE_URL ?? "/api/v1"}/${path}`, { signal, method: post ? "POST" : "GET" });
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
export async function getHistoricReplay(id: string, signal: AbortSignal) {
  if (import.meta.env.VITE_LUMEN_MOCK === "1") {
    const { mockReplay } = await import("./scenario-mock");
    return mockReplay();
  }
  const result = await read<{ landing_utc: string; landing_day: Replay }>(`historic/${encodeURIComponent(id)}/replay`, signal, true);
  return { landing_utc: result.landing_utc, timeline: result.landing_day.timeline };
}
