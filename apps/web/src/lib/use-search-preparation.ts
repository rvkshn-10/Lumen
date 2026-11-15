import { useEffect, useState } from "react";
import type { SearchRequest } from "./types";

const BASE = `${import.meta.env.VITE_API_BASE_URL ?? "/api/v1"}/search/preparation`;
export type PreparationState = { state: "preparing" | "ready" | "unavailable"; message?: string; id?: string };

export function speculativeRegion(region: SearchRequest["region"]) {
  if (region.selector_type === "southern_hemisphere") return region;
  const center = region.center, radius = region.search_radius_km;
  return center && Number.isFinite(center.latitude_deg) && center.latitude_deg > -87 && center.latitude_deg <= 0
    && Number.isFinite(center.longitude_deg_east) && center.longitude_deg_east >= -180 && center.longitude_deg_east < 180
    && radius != null && Number.isFinite(radius) && radius > 0 && radius <= 5 ? region : null;
}

export function useSearchPreparation(region: SearchRequest["region"], busy: boolean) {
  const [state, setState] = useState<PreparationState>({ state: "preparing" });
  const key = JSON.stringify(speculativeRegion(region));
  useEffect(() => {
    if (busy || import.meta.env.VITE_LUMEN_MOCK === "1") return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let owned: string | undefined;
    setState({ state: "preparing" });
    async function read(response: Response): Promise<PreparationState> {
      if (!response.ok) throw new Error("Preparation unavailable");
      const next = await response.json() as PreparationState;
      if (!["preparing", "ready", "unavailable"].includes(next.state)) throw new Error("Invalid preparation state");
      return next;
    }
    async function poll() {
      try {
        const next = await read(await fetch(owned ? `${BASE}/${owned}` : BASE, { signal: abort.signal }));
        if (abort.signal.aborted) return;
        setState(next);
        // Ready states also poll: leases and scientific revisions can expire.
        timer = setTimeout(() => void poll(), 1500);
      } catch {
        if (!abort.signal.aborted) setState({ state: "unavailable" });
      }
    }
    timer = setTimeout(() => {
      if (key === "null") { void poll(); return; }
      void fetch(BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ region: JSON.parse(key) }), signal: abort.signal })
        .then(read).then(next => {
          if (abort.signal.aborted) return;
          owned = next.id;
          setState(next);
          timer = setTimeout(() => void poll(), 1500);
        }).catch(() => { if (!abort.signal.aborted) setState({ state: "unavailable" }); });
    }, 800);
    return () => {
      clearTimeout(timer); abort.abort();
      if (owned) void fetch(`${BASE}/${owned}`, { method: "DELETE", keepalive: true }).catch(() => {});
    };
  }, [key, busy]);
  return state;
}
