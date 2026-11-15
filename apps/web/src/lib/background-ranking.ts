import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchRequest, SearchResponse } from "./types";
import type { CoverageCatalog } from "./planning";
import { canonical } from "./planning";
import { PlanningError, runAnalysis } from "./planning-api";

export interface RankingJob {
  key: string;
  abort: AbortController;
  state: "running" | "ready" | "failed";
  promise: Promise<SearchResponse>;
  result?: SearchResponse;
  error?: unknown;
  started: number;
}
export type RankingStatus = { key: string; state: RankingJob["state"]; message?: string } | null;

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Canceled", "AbortError")); }, { once: true });
});

/**
 * Starts ranking as soon as the mission is defined, so the leaderboard is ready
 * (or nearly) by the time the user asks for it. One job at a time: a newer
 * request replaces an older one, because the service runs one analysis at once.
 */
export function useBackgroundRanking(catalog: CoverageCatalog | null) {
  const job = useRef<RankingJob | null>(null);
  const [status, setStatus] = useState<RankingStatus>(null);

  const start = useCallback((request: SearchRequest) => {
    if (!catalog) return null;
    const key = canonical(request);
    if (job.current?.key === key && job.current.state !== "failed") return job.current;
    job.current?.abort.abort();
    const abort = new AbortController();
    const entry = { key, abort, state: "running", started: Date.now() } as RankingJob;
    entry.promise = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await runAnalysis(structuredClone(request), catalog, abort.signal, () => {});
        } catch (reason) {
          // A previous (replaced) job may still be finishing on the server.
          if (reason instanceof PlanningError && reason.code === "queue_full" && attempt < 40 && !abort.signal.aborted) {
            await sleep(Math.min(500 + attempt * 250, 2000), abort.signal);
            continue;
          }
          throw reason;
        }
      }
    })();
    entry.promise.then(result => {
      entry.state = "ready"; entry.result = result;
      if (job.current === entry) setStatus({ key, state: "ready" });
    }, reason => {
      entry.state = "failed"; entry.error = reason;
      if (job.current === entry && !abort.signal.aborted) setStatus({ key, state: "failed", message: reason instanceof Error ? reason.message : "Ranking failed." });
    });
    job.current = entry;
    setStatus({ key, state: "running" });
    return entry;
  }, [catalog]);

  const take = useCallback((request: SearchRequest) => {
    const key = canonical(request);
    return job.current?.key === key && job.current.state !== "failed" ? job.current : null;
  }, []);

  const cancel = useCallback(() => {
    job.current?.abort.abort(); job.current = null; setStatus(null);
  }, []);

  useEffect(() => () => job.current?.abort.abort(), []);
  return { status, start, take, cancel };
}
