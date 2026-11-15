import { describe, expect, it, vi } from "vitest";
import { DEFAULT_REQUEST } from "./missions";
import { mockScenario } from "./scenario-mock";
import { alternativeScenario, batteryMargin, loadScenario, nextEvent, sampledEvents, scenarioKey, scenarioShareHash, scenarioWindow, sharedScenarios, visibilityRuns } from "./scenarios";

describe("scenario comparisons", () => {
  const request = { ...DEFAULT_REQUEST, time_range: { start_utc: "2028-10-05T00:00:00Z", end_utc: "2028-10-12T00:00:00Z" } };
  const row = mockScenario("fixture-1", request);

  it("preserves the exact duration when changing the date", () => {
    const shifted = scenarioWindow(request, "2028-10-06T02:30:00Z");
    expect(shifted.time_range.end_utc).toBe("2028-10-13T02:30:00.000Z");
    expect(shifted.hard_constraints).toEqual(request.hard_constraints);
  });

  it("retains a fixed site's operating conditions across the launch-slip dates", () => {
    const planned = { ...request, power: { load_w: 120, capacity_wh: 500 }, dte_margin_deg: 3,
      scrub_time_utc: "2028-10-11T03:00:00Z" };
    const delayed = scenarioWindow(planned, "2028-10-08T00:00:00Z");
    expect(delayed.time_range).toEqual({ start_utc: "2028-10-08T00:00:00.000Z", end_utc: "2028-10-15T00:00:00.000Z" });
    expect(delayed).toMatchObject({ region: planned.region, hard_constraints: planned.hard_constraints,
      preferences: planned.preferences, power: planned.power, dte_margin_deg: 3 });
    expect(delayed.scrub_time_utc).toBeUndefined();
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

  it("retains failed-constraint evidence and suggestions when a changed date is analyzed", async () => {
    const status = { passes: false, region_pass: true, terrain_pass: true, temporal_pass: false };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ site: row.site, ...row.site,
      request, constraint_status: status, alternatives: [] })));
    try {
      const changed = await loadScenario(row.site.id, request, new AbortController().signal);
      expect(changed.constraint_status).toEqual(status);
      expect(changed.alternatives).toEqual([]);
    } finally { vi.unstubAllGlobals(); }
  });
});
