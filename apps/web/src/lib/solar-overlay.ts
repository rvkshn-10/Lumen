import { projectPolar } from "./coverage";

const API = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";

export interface SolarOverlay {
  time_utc: string;
  unit: "W";
  maximum_w: number;
  assumptions: { area_m2: number; efficiency: number; mount: string; solar_constant_w_m2: number; excludes: string[] };
  coarse: { model: string; step_deg: number; latitude_min_deg: number; longitude_min_deg: number; rows: number; columns: number; watts: number[] };
  terrain: null | { model: string; extent_m: [number, number, number, number]; step_m: number; side: number; watts: (number | null)[] };
}

export type OverlaySource = "terrain" | "coarse" | "unavailable";

export async function getSolarOverlay(timeUtc: string, signal: AbortSignal, panel?: { area_m2: number; efficiency: number }) {
  const params = new URLSearchParams({ time_utc: timeUtc });
  if (panel) { params.set("area_m2", String(panel.area_m2)); params.set("efficiency", String(panel.efficiency)); }
  const response = await fetch(`${API}/solar/overlay?${params}`, { signal });
  if (!response.ok) throw new Error(`Solar estimate unavailable (${response.status})`);
  return response.json() as Promise<SolarOverlay>;
}

/**
 * Estimated W at one latitude/longitude. Inside the prepared polar cap the
 * terrain-aware 2 km grid is used (null where no prepared site exists);
 * everywhere else the coarse 2° smooth-sphere grid, bilinearly interpolated.
 */
export function overlayValue(data: SolarOverlay, latitude: number, longitude: number): { watts: number | null; source: OverlaySource } {
  const terrain = data.terrain;
  if (terrain && latitude <= -87) {
    const [x, y] = projectPolar(latitude, longitude);
    const [left, , , top] = terrain.extent_m;
    const column = Math.round((x - left) / terrain.step_m), row = Math.round((top - y) / terrain.step_m);
    if (column >= 0 && row >= 0 && column < terrain.side && row < terrain.side) {
      const value = terrain.watts[row * terrain.side + column];
      return value == null ? { watts: null, source: "unavailable" } : { watts: value, source: "terrain" };
    }
  }
  const { coarse } = data;
  const r = Math.max(0, Math.min(coarse.rows - 1, (latitude - coarse.latitude_min_deg) / coarse.step_deg));
  let c = ((longitude - coarse.longitude_min_deg) / coarse.step_deg) % (coarse.columns - 1);
  if (c < 0) c += coarse.columns - 1;
  const r0 = Math.floor(r), c0 = Math.floor(c), r1 = Math.min(coarse.rows - 1, r0 + 1), c1 = Math.min(coarse.columns - 1, c0 + 1);
  const at = (row: number, column: number) => coarse.watts[row * coarse.columns + column];
  const tr = r - r0, tc = c - c0;
  const watts = (at(r0, c0) * (1 - tc) + at(r0, c1) * tc) * (1 - tr) + (at(r1, c0) * (1 - tc) + at(r1, c1) * tc) * tr;
  return { watts: Number.isFinite(watts) ? watts : null, source: Number.isFinite(watts) ? "coarse" : "unavailable" };
}
