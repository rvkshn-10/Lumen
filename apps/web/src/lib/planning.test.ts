import { describe, expect, it } from "vitest";
import { canonical, coverageLabel, publicLimitErrors, refineSurveyRequest, summaryHtml } from "./planning";
import type { CoverageCatalog } from "./planning";
import { DEFAULT_REQUEST } from "./missions";
import type { Candidate, SearchResponse } from "./types";

const catalog = { hemisphere_survey: true, hemisphere_detailed: true, public_limits: { maximum_radius_km: 5, maximum_live_days: 7, full_region_start_utc: "2028-10-01T00:00:00Z", full_region_end_utc: "2028-10-31T00:00:00Z" } } as CoverageCatalog;
const request = { ...structuredClone(DEFAULT_REQUEST), region: { selector_type: "circle" as const, center: { latitude_deg: -89.9, longitude_deg_east: 0 }, search_radius_km: 3 }, time_range: { start_utc: "2028-10-01T00:00:00Z", end_utc: "2028-10-08T00:00:00Z" } };
describe("guided planning contract", () => {
  it("blocks unavailable coverage and incompatible hemisphere requirements without changing inputs", () => {
    const survey = { ...structuredClone(request), region: { selector_type: "southern_hemisphere" as const } };
    expect(publicLimitErrors(survey, { ...catalog, hemisphere_survey: false })[0]).toContain("unavailable");
    survey.hard_constraints.science_feature_ids = ["retained-feature"];
    survey.hard_constraints.maximum_distance_to_science_feature_km = 10;
    expect(publicLimitErrors(survey, catalog)[0]).toContain("Named-feature");
    expect(survey.hard_constraints.science_feature_ids).toEqual(["retained-feature"]);
    const local = refineSurveyRequest(survey, { latitude_deg: -35, longitude_deg_east: 0 });
    expect(publicLimitErrors(local, { ...catalog, hemisphere_detailed: false })[0]).toContain("terrain is unavailable");
  });
  it("refines applied survey inputs without mutating their window, priorities or limits", () => {
    const applied = { ...structuredClone(request), region: { selector_type: "southern_hemisphere" as const } };
    const refined = refineSurveyRequest(applied, { latitude_deg: -35, longitude_deg_east: 42 });
    expect(refined.region).toEqual({ selector_type: "circle", center: { latitude_deg: -35, longitude_deg_east: 42 }, search_radius_km: 5 });
    expect(refined.time_range).toEqual(applied.time_range);
    expect(refined.preferences).toEqual(applied.preferences);
    expect(refined.hard_constraints).toEqual(applied.hard_constraints);
    refined.preferences.illumination = 99;
    expect(applied.preferences.illumination).not.toBe(99);
    expect(applied.region.selector_type).toBe("southern_hemisphere");
  });
  it("labels applied survey and local hemisphere coverage independently of the polar catalog", () => {
    const service = { ...catalog, label: "Prepared polar cap", hemisphere_detailed: true };
    expect(coverageLabel({ selector_type: "southern_hemisphere" }, service)).toContain("Whole southern hemisphere");
    expect(coverageLabel({ ...request.region, center: { latitude_deg: -35, longitude_deg_east: 0 } }, service)).toContain("detailed local");
    expect(coverageLabel(request.region, service)).toBe("Prepared polar cap");
  });
  it("compares normalized JSON independently of key order and absent optional fields", () => {
    expect(canonical({ b: null, a: { z: 1, y: 2 } })).toBe(canonical({ a: { y: 2, z: 1 } }));
    expect(canonical(request)).not.toBe(canonical({ ...request, preferences: { ...request.preferences, illumination: 1 } }));
  });
  it("uses advertised limits, retains inputs and requires the explicit full-region demo window", () => {
    expect(publicLimitErrors(request, catalog)).toEqual([]);
    const edited = { ...request, region: { ...request.region, search_radius_km: 6 }, time_range: { ...request.time_range, end_utc: "2028-10-09T00:00:00Z" } };
    expect(publicLimitErrors(edited, catalog)).toHaveLength(2);
    expect(edited.region.search_radius_km).toBe(6);
    expect(publicLimitErrors({ ...request, region: { selector_type: "full_supported_region" } }, catalog)).toHaveLength(1);
  });
  it("allows hemisphere surveys without a circle radius and retains the time limit", () => {
    const survey = { ...request, region: { selector_type: "southern_hemisphere" as const } };
    expect(publicLimitErrors(survey, catalog)).toEqual([]);
    expect(publicLimitErrors({ ...survey, time_range: { ...survey.time_range, end_utc: "2028-10-09T00:00:00Z" } }, catalog)).toHaveLength(1);
  });
  it("exports applied evidence, escapes content and includes up to four selected sites", () => {
    const site = { id:"a", rank:1, latitude_deg:-89.9, longitude_deg_east:0, slope_deg:2, criteria_scores:{illumination:.8,earth_visibility:.7,terrain_safety:.6,science_proximity:null}, metrics:{illumination_fraction:.8, earth_visibility_fraction:.7,longest_blackout_hours:2} } as Candidate;
    const result = { search_id:'<script>bad</script>', request, common_window:{ ...request.time_range, step_minutes:5 }, normalized_preferences:request.preferences, candidates:[site], assumptions:[], warnings:['<unsafe>'], provenance:{terrain:{dataset_version:'test',candidate_spacing_m:500,horizon_azimuth_step_deg:5}} } as unknown as SearchResponse;
    const html = summaryHtml(result, [site, site, site, site, site], 'Prepared <area>');
    expect(html).toContain('2028-10-08');
    expect(html).toContain('Prepared &lt;area&gt;');
    expect(html).not.toContain('<script>');
    expect(html.match(/<section>/g)).toHaveLength(4);
    expect(html).toContain('sampled time');
    expect(html).toContain('unavailable for these sites');
  });
});
