import { useEffect, useState } from "react";
import type { TerrainData } from "./types";
import { queueFetch } from "./queue-fetch";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";
const cache = new Map<string, Promise<TerrainData>>();

/** NASA LOLA 80 m/px terrain around one point (the cap overview is only 2 km/px). */
export function getLocalTerrain(xM: number, yM: number, halfKm: number, signal?: AbortSignal): Promise<TerrainData> {
  const key = `${Math.round(xM / 80)}:${Math.round(yM / 80)}:${Math.round(halfKm * 4)}`;
  let pending = cache.get(key);
  if (!pending) {
    const url = `${API_BASE}/terrain/local?x_m=${xM.toFixed(0)}&y_m=${yM.toFixed(0)}&half_km=${halfKm.toFixed(2)}`;
    pending = queueFetch(url, {}).then(async response => {
      if (!response.ok) throw new Error(`Local terrain unavailable (${response.status})`);
      return response.json() as Promise<TerrainData>;
    });
    pending.catch(() => cache.delete(key));
    cache.set(key, pending);
  }
  if (!signal) return pending;
  return Promise.race([pending, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Canceled", "AbortError")), { once: true }))]);
}

/** Frame that holds every site with some ground around it. */
export function siteFrame(sites: { x_m: number; y_m: number }[], minimumHalfKm = 3) {
  if (!sites.length) return null;
  const xs = sites.map(site => site.x_m), ys = sites.map(site => site.y_m);
  const x = (Math.min(...xs) + Math.max(...xs)) / 2, y = (Math.min(...ys) + Math.max(...ys)) / 2;
  const spread = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2000;
  return { x, y, halfKm: Math.min(40, Math.max(minimumHalfKm, spread * 1.45 + 1.5)) };
}

/** Swap in high-resolution terrain once it arrives; keep the overview until then (or if it fails). */
export function useLocalTerrain(frame: { x: number; y: number; halfKm: number } | null, fallback: TerrainData | null) {
  const [local, setLocal] = useState<{ key: string; terrain: TerrainData } | null>(null);
  const key = frame ? `${Math.round(frame.x / 80)}:${Math.round(frame.y / 80)}:${Math.round(frame.halfKm * 4)}` : "";
  useEffect(() => {
    if (!frame || import.meta.env.VITE_LUMEN_MOCK === "1") return;
    const abort = new AbortController();
    getLocalTerrain(frame.x, frame.y, frame.halfKm, abort.signal)
      .then(terrain => { if (!abort.signal.aborted) setLocal({ key, terrain }); })
      .catch(() => {});
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return local?.key === key ? local.terrain : fallback;
}
