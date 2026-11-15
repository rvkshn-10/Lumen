import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_REQUEST } from "../lib/missions";
import { mockScenario } from "../lib/scenario-mock";
import { EngineerComparison } from "./EngineerComparison";

describe("engineering comparison evidence", () => {
  it("keeps absent optional science values unavailable and preserves zero measurements", () => {
    const row = mockScenario("fixture-1", structuredClone(DEFAULT_REQUEST));
    row.site.power = undefined;
    row.site.dte = undefined;
    row.site.roughness_m = 0;
    const html = renderToStaticMarkup(<EngineerComparison rows={[row]} />);
    expect(html).toContain("0.000 m");
    expect(html).toContain("Unavailable");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
  });

  it("shows each scenario's own limits, window and battery assumptions", () => {
    const first = mockScenario("fixture-1", { ...structuredClone(DEFAULT_REQUEST), hard_constraints: { maximum_slope_deg: 8, minimum_illumination_fraction: 0.75 }, power: { capacity_wh: 3000, start_soc: 0.5, load_w: 100 } });
    const second = mockScenario("fixture-2", { ...structuredClone(DEFAULT_REQUEST), hard_constraints: {} });
    const html = renderToStaticMarkup(<EngineerComparison rows={[first, second]} />);
    expect(html).toContain("75.000 %");
    expect(html).toContain("8.000 °");
    expect(html).toContain("3000.000 Wh");
    expect(html).toContain("50.0000 %");
    expect(html).toContain("Not set");
    expect(html).toContain("Site A · Calculation inputs");
    expect(html).toContain("Site B · Calculation inputs");
    expect(html).toContain(first.request.time_range.start_utc);
  });
});
