import { afterEach, describe, expect, it, vi } from "vitest";
import { runAnalysis } from "./planning-api";
import type { CoverageCatalog } from "./planning";
import { DEFAULT_REQUEST } from "./missions";
const catalog = { search_service: { mode: "jobs" } } as CoverageCatalog;
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("analysis job adapter", () => {
  it.each([false, true])("hands off optional preparation before submitting, even when handoff fails (%s)", async fail => {
    const result = { search_id: "exact-result" };
    const fetch = vi.fn();
    if (fail) fetch.mockRejectedValueOnce(new TypeError("Preparation disconnected"));
    else fetch.mockResolvedValueOnce(Response.json({ state: "ready" }));
    fetch.mockResolvedValueOnce(Response.json(result));
    vi.stubGlobal("fetch", fetch);
    const service = { ...catalog, search_service: { mode: "synchronous" as const, background_preparation: true } };
    expect(await runAnalysis(DEFAULT_REQUEST, service, new AbortController().signal, () => {})).toEqual(result);
    expect(fetch.mock.calls.map(call => call[0])).toEqual(["/api/v1/search/preparation/yield", "/api/v1/candidates/search"]);
  });
  it("reports server states and returns only the completed result", async () => {
    vi.useFakeTimers();
    const result = { search_id: "applied" };
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ job_id:"a",status:"queued",queue_position:2 }, {status:202})).mockResolvedValueOnce(Response.json({job_id:"a",status:"running"})).mockResolvedValueOnce(Response.json({job_id:"a",status:"complete",result}));
    vi.stubGlobal("fetch", fetch);
    const states: string[] = [];
    const pending = runAnalysis(DEFAULT_REQUEST,catalog,new AbortController().signal,state => states.push(state.phase));
    await vi.runAllTimersAsync();
    expect(await pending).toEqual(result);
    expect(states).toEqual(["submitting","queued","running"]);
  });
  it("requests server cancellation and never returns a canceled result", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const fetch = vi.fn().mockResolvedValue(Response.json({job_id:"a",status:"queued"},{status:202}));
    vi.stubGlobal("fetch", fetch);
    const pending = runAnalysis(DEFAULT_REQUEST,catalog,abort.signal,state => { if(state.phase === "queued") abort.abort(); });
    await expect(pending).rejects.toMatchObject({name:"AbortError"});
    expect(fetch).toHaveBeenCalledWith("/api/v1/jobs/a", {method:"DELETE"});
  });
  it.each([[429,"queue_full"],[410,"expired"],[503,"waking"]])("preserves actionable HTTP %s states", async (status,code) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, {status:status as number})));
    await expect(runAnalysis(DEFAULT_REQUEST,catalog,new AbortController().signal,()=>{})).rejects.toMatchObject({code});
  });
});
