import type {
  RegionManifest,
  SearchRequest,
  SearchResponse,
  SearchValidationResponse,
  TerrainData,
  FeatureCollection,
  PSRLayer,
  SiteDetail,
  TimeSample,
} from "./types";
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";

export function getFeatures(signal?: AbortSignal): Promise<FeatureCollection> {
  return fetch(`${API_BASE}/features`, { signal }).then(
    expectJson<FeatureCollection>,
  );
}
export function getPSRLayer(signal?: AbortSignal): Promise<PSRLayer> {
  return fetch(`${API_BASE}/layers/psr`, { signal }).then(expectJson<PSRLayer>);
}
export function getSiteAnalysis(
  id: string,
  request: SearchRequest,
  signal?: AbortSignal,
): Promise<SiteDetail> {
  return fetch(`${API_BASE}/sites/${encodeURIComponent(id)}/analysis`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  }).then(expectJson<SiteDetail>);
}
async function expectJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = body?.detail;
    const message =
      typeof detail === "string"
        ? detail
        : Array.isArray(detail)
          ? detail
              .map(
                (issue: { msg: string; loc: string[] }) =>
                  `${issue.loc.slice(1).join(" ")}: ${issue.msg}`,
              )
              .join(". ")
          : (detail?.message ??
            `Request failed (${response.status}). Try again.`);
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
export function getRegionManifest(
  signal?: AbortSignal,
): Promise<RegionManifest> {
  return fetch(`${API_BASE}/region`, { signal }).then(
    expectJson<RegionManifest>,
  );
}
export function getTerrain(signal?: AbortSignal): Promise<TerrainData> {
  return fetch(`${API_BASE}/terrain`, { signal }).then(expectJson<TerrainData>);
}
export function searchCandidates(
  input: SearchRequest,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  return fetch(`${API_BASE}/candidates/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  }).then(expectJson<SearchResponse>);
}
export function validateSearch(
  input: SearchRequest,
): Promise<SearchValidationResponse> {
  return fetch(`${API_BASE}/search/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then(expectJson<SearchValidationResponse>);
}

export type HorizonSample = Pick<
  TimeSample,
  | "time_utc"
  | "sun_elevation_deg"
  | "sun_horizon_deg"
  | "earth_elevation_deg"
  | "earth_horizon_deg"
  | "sun_visible"
  | "earth_visible"
>;

export interface HorizonReviewResult {
  engine: "OpenVINO";
  device: string;
  model: string;
  samples: number;
  agreement: number;
  sun_agreement: number;
  earth_agreement: number;
  disagreement_indices: number[];
  inference_ms?: number;
  near_horizon_samples?: number;
  runtime_version?: string;
}

export async function reviewHorizon(
  samples: HorizonSample[],
  signal: AbortSignal,
): Promise<HorizonReviewResult> {
  const response = await fetch(`${API_BASE}/ai/horizon-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ samples }),
    signal,
  });
  if (response.status === 503 || response.status === 404) {
    throw new Error("OpenVINO review is unavailable on this server.");
  }
  return expectJson<HorizonReviewResult>(response);
}
