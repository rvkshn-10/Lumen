import { describe, expect, it } from "vitest";
import { DEFAULT_REQUEST } from "./missions";
import { mockScenario } from "./scenario-mock";
import { alternativeScenario, batteryMargin, nextEvent, sampledEvents, scenarioKey, scenarioShareHash, scenarioWindow, sharedScenarios, visibilityRuns } from "./scenarios";

describe("scenario comparisons", () => {
  const request = { ...DEFAULT_REQUEST, time_range: { start_utc: "2028-10-05T00:00:00Z", end_utc: "2028-10-12T00:00:00Z" } };
  const row = mockScenario("fixture-1", request);

  it("preserves the exact duration when changing the date", () => {
    const shifted = scenarioWindow(request, "2028-10-06T02:30:00Z");
    expect(shifted.time_range.end_utc).toBe("2028-10-13T02:30:00.000Z");
    expect(shifted.hard_constraints).toEqual(request.hard_constraints);
  });

  it("uses supplied events and estimates legacy transitions from samples", () => {
    const start = Date.parse(request.time_range.start_utc);
    expect(nextEvent(row.site, "sunset", start)).toEqual(row.site.events?.[0]);
    expect(nextEvent(row.site, "sunset", Date.parse(request.time_range.end_utc))).toBeUndefined();
    const legacySunset = sampledEvents(row.site.timeline).find(event => event.type === "sunset");
    expect(legacySunset?.uncertainty_minutes).toBe(30);
    expect(Date.parse(legacySunset!.time_utc)).toBe(Date.parse(row.site.events![0].time_utc) - 30 * 60_000);
  });

  it("closes visibility bands at the exclusive end and checks battery reserve", () => {
    const runs = visibilityRuns(row.site, request, "sun_visible");
    expect(runs.map(run => run.visible)).toEqual([true, false]);
    expect(runs.at(-1)?.end).toBe(Date.parse(request.time_range.end_utc));
    expect(batteryMargin(2000, 100, 18)).toBe(2);
    expect(batteryMargin(2000, 100, 23)).toBe(-3);
  });

  it("shares request descriptors without timelines or trusted result values", () => {
    expect(sharedScenarios(scenarioShareHash([row]))).toEqual([{ id: row.site.id, request, label: "Candidate 1" }]);
    expect(sharedScenarios("#scenarios=%zz")).toEqual([]);
    expect(sharedScenarios(scenarioShareHash(Array(9).fill(row)))).toEqual([]);
  });

  it("uses Track A's nearby id and explicit relaxation request", () => {
    const nearby = { id: "prepared-neighbor", kind: "nearby" as const, for_site: row.site.id,
      resolves: ["maximum_slope_deg"], metrics: row.site.metrics, reason: "Lower slope", request };
    expect(alternativeScenario(nearby)?.id).toBe("prepared-neighbor");
    const changed = { ...request, hard_constraints: { maximum_slope_deg: 12 } };
    expect(alternativeScenario({ ...nearby, kind: "relaxed", request: changed })).toEqual({ id: row.site.id, request: changed });
  });

  it("keeps distinct power and DTE scenarios and clears a stale scrub clock on date changes", () => {
    expect(scenarioKey(row.site.id, request)).not.toBe(scenarioKey(row.site.id, { ...request, dte_margin_deg: 4 }));
    expect(scenarioKey(row.site.id, request)).not.toBe(scenarioKey(row.site.id, { ...request, power: { area_m2: 3 } }));
    expect(scenarioKey(row.site.id, request)).toBe(scenarioKey(row.site.id, { ...request, dte_margin_deg: 2 }));
    expect(scenarioWindow({ ...request, scrub_time_utc: request.time_range.start_utc }, "2028-11-01T00:00:00Z").scrub_time_utc).toBeUndefined();
  });
});
