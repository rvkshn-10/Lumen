import type { PowerEstimate } from "./types";

/** Plain description of the panel model shared by the chart and the 3D overlay. */
export function panelAssumptionText(assumptions: Pick<PowerEstimate["assumptions"], "area_m2" | "efficiency" | "solar_constant_w_m2"> & { excludes?: string[] }) {
  const area = Number(assumptions.area_m2.toPrecision(3));
  const efficiency = Number((assumptions.efficiency * 100).toPrecision(3));
  const excludes = assumptions.excludes?.filter(item => item !== "battery efficiency").join(", ");
  return `Panel: ${area} m², ${efficiency}% efficient, kept facing the Sun (vertical, sun-tracking); sunlight ${assumptions.solar_constant_w_m2.toLocaleString()} W/m² at 1 AU, scaled to the Sun’s distance and the visible part of the Sun’s disk.${excludes ? ` Excludes ${excludes}.` : ""}`;
}

/** Sequential legend for the overlay, dark (0 W) to bright (maximum). */
export const SOLAR_STOPS = ["#14163a", "#2b3a8c", "#1f8a9a", "#7cc46a", "#f4e04d", "#fff7c2"] as const;
export const UNAVAILABLE_COLOR = "#8a5a73";

function mix(a: string, b: string, t: number) {
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16)), pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
  return pa.map((value, i) => (value + (pb[i] - value) * t) / 255) as [number, number, number];
}

/** RGB (0–1) for a W value on a 0…maximum scale; null means no estimate. */
export function solarColor(value: number | null | undefined, maximum: number): [number, number, number] {
  if (value == null || !Number.isFinite(value)) return mix(UNAVAILABLE_COLOR, UNAVAILABLE_COLOR, 0);
  const t = Math.max(0, Math.min(1, value / Math.max(maximum, 1))) * (SOLAR_STOPS.length - 1);
  const index = Math.min(SOLAR_STOPS.length - 2, Math.floor(t));
  return mix(SOLAR_STOPS[index], SOLAR_STOPS[index + 1], t - index);
}
