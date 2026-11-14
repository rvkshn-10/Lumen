import { HOUR_MS, visibilityRuns } from "./scenarios";
import type { Scenario } from "./scenarios";
import type { TimeSample } from "./types";

export type WindowRequirement = "earth" | "sun" | "both";
type Interval = { start: number; end: number };
export type ClearanceLimits = { solarDiskPercent: number; earthDegrees: number };

export const WINDOW_REQUIREMENTS: Record<WindowRequirement, string> = {
  earth: "Earth in view",
  sun: "Sunlight",
  both: "Sunlight and Earth in view",
};

function visibleIntervals(row: Scenario, body: "earth" | "sun"): Interval[] {
  const refined = row.site.visibilityIntervals?.[body];
  if (refined) return refined.filter(interval => interval.visible).map(interval => ({
    start: Date.parse(interval.start_utc), end: Date.parse(interval.end_utc),
  }));
  return visibilityRuns(row.site, row.request, body === "earth" ? "earth_visible" : "sun_visible")
    .filter(interval => interval.visible);
}

function overlap(first: Interval[], second: Interval[]): Interval[] {
  const intervals: Interval[] = [];
  let i = 0, j = 0;
  while (i < first.length && j < second.length) {
    const start = Math.max(first[i].start, second[j].start);
    const end = Math.min(first[i].end, second[j].end);
    if (end > start) intervals.push({ start, end });
    if (first[i].end <= second[j].end) i++;
    else j++;
  }
  return intervals;
}

function clearanceIntervals(row: Scenario, requirement: WindowRequirement, limits: ClearanceLimits): Interval[] {
  const { timeline } = row.site;
  const intervals: Interval[] = [];
  const end = Date.parse(row.request.time_range.end_utc);
  for (let i = 0; i + 1 < timeline.length; i++) {
    const point = timeline[i];
    const start = Date.parse(point.time_utc);
    const next = Math.min(end, Date.parse(timeline[i + 1].time_utc));
    if (next <= start) continue;
    const sun = point.sun_visible && point.solar_fraction >= limits.solarDiskPercent / 100;
    const earth = point.earth_visible && point.earth_elevation_deg - point.earth_horizon_deg > limits.earthDegrees;
    if (!(requirement === "both" ? sun && earth : requirement === "sun" ? sun : earth)) continue;
    const last = intervals.at(-1);
    if (last?.end === start) last.end = next;
    else intervals.push({ start, end: next });
  }
  return intervals;
}

export function checkWindow(row: Scenario, requirement: WindowRequirement, minimumHours: number, limits?: ClearanceLimits) {
  const intervals = limits ? clearanceIntervals(row, requirement, limits) : requirement === "both"
    ? overlap(visibleIntervals(row, "earth"), visibleIntervals(row, "sun"))
    : visibleIntervals(row, requirement);
  const longest = intervals.reduce<Interval | undefined>((best, window) =>
    !best || window.end - window.start > best.end - best.start ? window : best, undefined);
  const available = row.site.timeline.length >= 2;
  const longestHours = longest ? (longest.end - longest.start) / HOUR_MS : 0;
  return {
    available, longest, longestHours,
    marginHours: longestHours - minimumHours,
    meets: available && longestHours >= minimumHours,
    method: !limits && row.site.visibilityIntervals ? "Refined transitions" : "Sampled intervals",
  };
}

export function sampleIndexAt(timeline: TimeSample[], time: number): number {
  let left = 0, right = timeline.length;
  while (left < right) {
    const middle = left + Math.floor((right - left) / 2);
    if (Date.parse(timeline[middle].time_utc) <= time) left = middle + 1;
    else right = middle;
  }
  return left - 1;
}
