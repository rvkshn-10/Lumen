import { describe, expect, it } from "vitest";
import { speculativeRegion } from "./use-search-preparation";

describe("speculative search selection", () => {
  it("accepts southern survey and bounded southern local geometry without mission dates", () => {
    expect(speculativeRegion({ selector_type: "southern_hemisphere" })).toEqual({ selector_type: "southern_hemisphere" });
    const area = { selector_type: "circle" as const, center: { latitude_deg: -35, longitude_deg_east: 90 }, search_radius_km: 5 };
    expect(speculativeRegion(area)).toEqual(area);
    for (const changed of [
      { ...area, search_radius_km: 6 }, { ...area, search_radius_km: NaN },
      { ...area, center: { ...area.center, latitude_deg: -89 } },
      { ...area, center: { ...area.center, latitude_deg: 1 } },
      { ...area, center: { ...area.center, longitude_deg_east: Infinity } },
    ]) expect(speculativeRegion(changed)).toBeNull();
    expect(speculativeRegion({ selector_type: "full_supported_region" })).toBeNull();
    const extended = { ...area, search_radius_km: 15 };
    expect(speculativeRegion(extended)).toBeNull();
    expect(speculativeRegion(extended, 15)).toEqual(extended);
  });
});
