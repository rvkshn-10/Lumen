import { describe, expect, it } from "vitest";
import { overlayValue, type SolarOverlay } from "./solar-overlay";
import { solarColor, UNAVAILABLE_COLOR } from "./solar-model";

const base: SolarOverlay = {
  time_utc: "2028-10-01T00:00:00Z", unit: "W", maximum_w: 424,
  assumptions: { area_m2: 1, efficiency: .3, mount: "vertical_tracking", solar_constant_w_m2: 1361, excludes: [] },
  coarse: { model: "coarse", step_deg: 90, latitude_min_deg: -90, longitude_min_deg: -180, rows: 3, columns: 5, watts: [0, 0, 0, 0, 0, 100, 200, 300, 400, 100, 0, 0, 0, 0, 0] },
  terrain: { model: "terrain", extent_m: [-100000, -100000, 100000, 100000], step_m: 100000, side: 3, watts: [1, 2, 3, 4, null, 6, 7, 8, 9] },
};

describe("solar overlay sampling", () => {
  it("uses terrain values in the cap and marks missing prepared sites as unavailable", () => {
    expect(overlayValue(base, -89.999, 0)).toEqual({ watts: null, source: "unavailable" });
    expect(overlayValue(base, -87.5, 0).source).toBe("terrain");
  });
  it("interpolates the coarse grid elsewhere, keeping 0 W valid", () => {
    expect(overlayValue(base, 0, -90)).toEqual({ watts: 200, source: "coarse" });
    expect(overlayValue(base, 45, -45).watts).toBeCloseTo(125);
    expect(overlayValue(base, 90, 0)).toEqual({ watts: 0, source: "coarse" });
  });
  it("colors unavailable data differently from 0 W", () => {
    const hex = (rgb: number[]) => "#" + rgb.map(v => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
    expect(hex(solarColor(null, 400))).toBe(UNAVAILABLE_COLOR);
    expect(hex(solarColor(0, 400))).not.toBe(UNAVAILABLE_COLOR);
  });
});
