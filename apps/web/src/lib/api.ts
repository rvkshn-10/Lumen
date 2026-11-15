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
import type { BriefInterpretation } from "./brief";
import { queueFetch } from "./queue-fetch";
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
  includeAlternatives = true,
): Promise<SiteDetail> {
  const analysisUrl = `${API_BASE}/sites/${encodeURIComponent(id)}/analysis`;
  return queueFetch(includeAlternatives ? analysisUrl : `${analysisUrl}?include_alternatives=false`, {
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
  signal?: AbortSignal,
): Promise<SearchValidationResponse> {
  return fetch(`${API_BASE}/search/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  }).then(expectJson<SearchValidationResponse>);
}

export async function getCopilotStatus(signal: AbortSignal): Promise<boolean> {
  const response = await fetch(`${API_BASE}/ai/copilot-status`, { signal });
  return response.ok && (await expectJson<{ available: boolean }>(response)).available === true;
}

export class CopilotUnavailableError extends Error {
  constructor() {
    super("OpenVINO copilot is unavailable on this server.");
  }
}

type CopilotResponse = { engine: "openvino-genai" };

export interface MissionDraft extends BriefInterpretation {
  validation_errors?: string[];
}

async function askCopilot<T>(path: string, input: object, signal: AbortSignal): Promise<T & CopilotResponse> {
  const response = await fetch(`${API_BASE}/ai/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (response.status === 503 || response.status === 404) {
    throw new CopilotUnavailableError();
  }
  return expectJson<T & CopilotResponse>(response);
}

export function draftMissionBrief(brief: string, base: SearchRequest, signal: AbortSignal) {
  return askCopilot<MissionDraft>("mission-draft", { brief, base }, signal);
}

export interface ExplanationCandidate {
  name: string;
  sunlight_fraction: number;
  earth_visibility_fraction: number;
  longest_darkness_hours: number;
}

export type ExplanationGoal = "balanced" | "sunlight" | "earth" | "darkness";

export function explainMissionComparison(
  candidates: ExplanationCandidate[],
  goal: ExplanationGoal,
  signal: AbortSignal,
) {
  return askCopilot<{ explanation: string }>("mission-explanation", { candidates, goal }, signal);
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

interface HorizonBand {
  labels: number;
  disagreements: number;
}

export interface HorizonDisagreement {
  sample_index: number;
  body: "sun" | "earth";
  clearance_deg: number;
  near_horizon: boolean;
  model_visible: boolean;
  physics_visible: boolean;
}

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
  near_horizon_deg?: number;
  near_horizon?: HorizonBand;
  outside_horizon_band?: HorizonBand;
  disagreements?: HorizonDisagreement[];
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
