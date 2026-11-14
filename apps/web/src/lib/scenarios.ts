import { getSiteAnalysis } from "./api";
import { isMissionRequest } from "./missions";
import { withinSearchDeadline } from "./deadline";
import { canonical } from "./planning";
import type { Alternative as ContractAlternative, BodyEvent, Candidate, SearchRequest, SearchResponse, SiteDetail, TimeSample, VisibilityInterval } from "./types";

export type LunarEvent = BodyEvent;
export type ScenarioSite = Candidate & {
  visibilityIntervals?: { sun: VisibilityInterval[]; earth: VisibilityInterval[] };
  constraintStatus?: SiteDetail["constraint_status"];
};
export interface Scenario {
  key: string;
  site: ScenarioSite;
  request: SearchRequest;
  label?: string;
}
export type Alternative = ContractAlternative & { site_id?: string };
export type ScenarioResult = SearchResponse & { alternatives?: Alternative[] };
export type Audience = "Public" | "Educator" | "Planner";
export const MAX_SCENARIOS = 8;
export const COMPARE_LIMIT = 4;
export const SITE_COLORS = ["#56b4e9", "#e69f00", "#009e73", "#cc79a7"];
export const HOUR_MS = 3_600_000;

export function scenarioKey(siteId: string, request: SearchRequest) {
  return canonical([siteId, request.time_range, request.hard_constraints, request.preferences,
    request.dte_margin_deg ?? 2, { area_m2: 1, efficiency: .3, load_w: 150,
      capacity_wh: 2000, start_soc: 1, ...request.power }]);
}

export function scenarioWindow(request: SearchRequest, start: string): SearchRequest {
  const original = request.time_range;
  const startMs = Date.parse(start);
  const endMs = startMs + Date.parse(original.end_utc) - Date.parse(original.start_utc);
  return { ...request, scrub_time_utc: undefined, time_range: { start_utc: new Date(startMs).toISOString(), end_utc: new Date(endMs).toISOString() } };
}

export function sampledEvents(timeline: TimeSample[]): LunarEvent[] {
  return timeline.slice(1).flatMap((sample, index) => {
    const before = timeline[index];
    const eventTime = (Date.parse(sample.time_utc) + Date.parse(before.time_utc)) / 2;
    const uncertainty_minutes = Math.ceil((Date.parse(sample.time_utc) - Date.parse(before.time_utc)) / 120_000);
    const event = { time_utc: new Date(eventTime).toISOString(), uncertainty_minutes };
    return [
      ...(sample.sun_visible !== before.sun_visible ? [{ ...event, type: sample.sun_visible ? "sunrise" as const : "sunset" as const }] : []),
      ...(sample.earth_visible !== before.earth_visible ? [{ ...event, type: sample.earth_visible ? "earthrise" as const : "earthset" as const }] : []),
    ];
  });
}

export function nextEvent(site: ScenarioSite, type: LunarEvent["type"], after: number): LunarEvent | undefined {
  return (site.events ?? sampledEvents(site.timeline)).filter(event => event.type === type && Date.parse(event.time_utc) >= after)
    .reduce<LunarEvent | undefined>((first, event) => !first || Date.parse(event.time_utc) < Date.parse(first.time_utc) ? event : first, undefined);
}

export function visibilityRuns(site: ScenarioSite, request: SearchRequest, key: "sun_visible" | "earth_visible") {
  const end = Date.parse(request.time_range.end_utc);
  const runs: { start: number; end: number; visible: boolean }[] = [];
  site.timeline.forEach((sample, index) => {
    const start = Date.parse(sample.time_utc);
    const next = Math.min(end, site.timeline[index + 1] ? Date.parse(site.timeline[index + 1].time_utc) : end);
    if (next <= start) return;
    const previous = runs.at(-1);
    const visible = sample[key];
    if (previous?.visible === visible && previous.end === start) previous.end = next;
    else runs.push({ start, end: next, visible });
  });
  return runs;
}

export async function loadScenario(id: string, request: SearchRequest, signal: AbortSignal, includeAlternatives = true): Promise<Scenario> {
  if (import.meta.env.VITE_LUMEN_MOCK === "1") {
    const { mockScenario } = await import("./scenario-mock");
    return mockScenario(id, request);
  }
  const detail = await withinSearchDeadline(signal, active => getSiteAnalysis(id, request, active, includeAlternatives)) as Awaited<ReturnType<typeof getSiteAnalysis>>
    & Pick<ScenarioSite, "events" | "power" | "score" | "criteria_scores">
    & { refinement: { transitions?: { body: "sun" | "earth"; visible_after: boolean; time_utc: string; bracket_seconds: number }[] } };
  const events = detail.events ?? detail.refinement.transitions?.map((event): LunarEvent => ({
    type: event.body === "sun" ? (event.visible_after ? "sunrise" : "sunset") : (event.visible_after ? "earthrise" : "earthset"),
    time_utc: event.time_utc, uncertainty_minutes: Math.ceil(event.bracket_seconds / 120),
  }));
  const applied = detail.request ?? request;
  return { key: scenarioKey(id, applied), request: applied,
    site: { ...detail.site, rank: 0, score: detail.score, criteria_scores: detail.criteria_scores,
      metrics: detail.metrics, timeline: detail.timeline, horizon: detail.horizon, events, visibilityIntervals: detail.intervals, constraintStatus: detail.constraint_status, power: detail.power, dte: detail.dte } };
}

export function alternativeScenario(alternative: Alternative, fallback?: SearchRequest) {
  const request = alternative.request ?? fallback;
  if (!request) return null;
  if (alternative.kind === "nearby") return { id: alternative.site_id ?? alternative.id, request };
  if (alternative.request) return { id: alternative.for_site, request: alternative.request };
  if (alternative.kind === "shifted_window" && alternative.shift_hours != null) {
    return { id: alternative.for_site, request: scenarioWindow(request,
      new Date(Date.parse(request.time_range.start_utc) + alternative.shift_hours * HOUR_MS).toISOString()) };
  }
  return null;
}

export function batteryMargin(capacityWh: number, loadW: number, darknessHours: number) {
  return capacityWh / loadW - darknessHours;
}

export type ScenarioLink = { id: string; request: SearchRequest; label?: string };

export function sharedScenarios(hash: string): ScenarioLink[] {
  try {
    const payload: unknown = JSON.parse(decodeURIComponent(hash.replace(/^#scenarios=/, "")));
    if (!Array.isArray(payload) || payload.length === 0 || payload.length > MAX_SCENARIOS) return [];
    return payload.every(row => row && typeof row.id === "string" && row.id.length <= 128 &&
      (row.label == null || (typeof row.label === "string" && row.label.length <= 128)) &&
      isMissionRequest(row.request) && Date.parse(row.request.time_range.end_utc) > Date.parse(row.request.time_range.start_utc))
      ? payload : [];
  } catch { return []; }
}

export function scenarioShareHash(rows: Scenario[]) {
  return `#scenarios=${encodeURIComponent(JSON.stringify(rows.map(row => ({
    id: row.site.id, request: row.request, label: row.label ?? (row.site.rank ? `Candidate ${row.site.rank}` : undefined),
  }))))}`;
}
