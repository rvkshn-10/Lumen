import { HOUR_MS, scenarioKey } from "./scenarios";
import type { Scenario, ScenarioResult, ScenarioSite } from "./scenarios";
import type { SearchRequest, TimeSample } from "./types";

// Synthetic values for Track C UI development only. No values here are scientific results.
export function mockScenario(id: string, request: SearchRequest): Scenario {
  const rank = Number(id.split("-").at(-1)) || 1;
  const siteId = `fixture-${rank}`;
  const start = Date.parse(request.time_range.start_utc), end = Date.parse(request.time_range.end_utc);
  const duration = (end - start) / HOUR_MS;
  const at = (hour: number) => new Date(start + hour * HOUR_MS).toISOString();
  const sunset = Math.floor(duration * (.42 + .09 * rank));
  const earthset = Math.floor(duration * (.90 - .12 * rank));
  const timeline: TimeSample[] = Array.from({ length: Math.ceil(duration) }, (_, hour) => ({
    time_utc: at(hour), sun_azimuth_deg: (hour * 2) % 360,
    sun_elevation_deg: .5 + (sunset - hour) / Math.max(1, duration) * 8,
    earth_azimuth_deg: 10, earth_elevation_deg: hour < earthset ? 3 : -1,
    sun_horizon_deg: .5, earth_horizon_deg: 0, solar_fraction: hour < sunset ? 1 : 0,
    sun_visible: hour < sunset, earth_visible: hour < earthset,
  }));
  const series = timeline.map((sample, hour) => ({ time_utc: sample.time_utc,
    vertical_w: sample.sun_visible ? Math.max(0, 360 - hour) : 0, horizontal_w: sample.sun_visible ? 25 : 0 }));
  const integrate = (key: "vertical_w" | "horizontal_w") => series.reduce((total, row, index) => total + row[key] * Math.min(1, duration - index), 0);
  const site: ScenarioSite = {
    id: siteId, rank, latitude_deg: -89.9 + rank * .005, longitude_deg_east: rank * .01,
    x_m: rank * 500, y_m: 0, elevation_m: 100, slope_deg: 3 + rank, roughness_m: 12, score: 90 - rank,
    criteria_scores: { illumination: .8, earth_visibility: .7, terrain_safety: .9, science_proximity: null },
    metrics: { illumination_fraction: sunset / duration, mean_visible_solar_disk_fraction: sunset / duration,
      earth_visibility_fraction: earthset / duration, longest_sunlight_hours: sunset, longest_darkness_hours: duration - sunset,
      longest_communication_hours: earthset, longest_blackout_hours: duration - earthset },
    timeline, horizon: [], power: { assumptions: { area_m2: 1, efficiency: .3, mount: "vertical tracking" },
      series, energy_wh: integrate("vertical_w"), horizontal_energy_wh: integrate("horizontal_w") },
    events: [{ type: "sunset", time_utc: at(sunset), uncertainty_minutes: 1 },
      { type: "earthset", time_utc: at(earthset), uncertainty_minutes: 1 }],
  };
  return { key: scenarioKey(site.id, request), site, request };
}

export function mockAnalysis(request: SearchRequest): ScenarioResult {
  const candidates = [1, 2, 3, 4].map(rank => mockScenario(`fixture-${rank}`, request).site);
  const alternative = candidates[2];
  return { search_id: `fixture-${request.time_range.start_utc}`, status: "complete", request, candidates,
    counts: { total: 4, region: 4, terrain_pass: 4, temporal_pass: 4, shortlisted: 4 },
    normalized_preferences: request.preferences, assumptions: ["Synthetic Track C fixtures"],
    warnings: [], provenance: { synthetic: true }, common_window: { ...request.time_range, step_minutes: 60 },
    alternatives: [{ id: "example-nearby", kind: "nearby", for_site: candidates[0].id, site_id: alternative.id,
      distance_km: 1, resolves: ["maximum_continuous_darkness_hours"], metrics: alternative.metrics,
      reason: "Example: a nearby location shortens the longest stretch of darkness." }],
  };
}

export const mockPlaces = [
  { id: "fixture-region", name: "Example polar region", kind: "artemis_region", latitude_deg: -89.9, longitude_deg_east: 0,
    analysis: "detailed", source_url: "https://www.nasa.gov/", blurb: "Synthetic example for testing the picker." },
  { id: "fixture-replay", name: "Example historic replay", kind: "historic", latitude_deg: 0, longitude_deg_east: 0, landing_utc: "2028-10-01T00:00:00Z",
    analysis: "coarse", source_url: "https://www.nasa.gov/", blurb: "Synthetic example for testing replay." },
] satisfies import("./experience-api").CuratedSite[];

export function mockReplay() {
  const landing_utc = "2028-10-01T00:00:00Z";
  return { landing_utc, timeline: Array.from({ length: 25 }, (_, index) => ({
    time_utc: new Date(Date.parse(landing_utc) + (index - 12) * HOUR_MS).toISOString(),
    sun_elevation_deg: 2 + index / 4,
  })) };
}
