import type { Candidate, TimeSample } from "./types";

/**
 * Terrain-aware local-sky helpers shared by the sky dome, the 360° panorama,
 * terrain sight lines and the scene-parity dump.
 *
 * Visibility is never recomputed for display: the API's per-sample
 * `sun_visible` / `earth_visible` flags are the truth, and every view styles
 * from them. Geometry here only decides *where* to draw.
 */
export type Body = "sun" | "earth";
export type HorizonPoint = Candidate["horizon"][number];

export const BODY_COLORS: Record<Body, string> = { sun: "#f0c870", earth: "#8fc3e3" };
export const BLOCKED_COLOR = "#7d8784";
/** Okabe–Ito: distinguishable with the common colour-vision deficiencies. */
export const COMPARE_COLORS = ["#E69F00", "#56B4E9", "#009E73", "#CC79A7"] as const;
/** Four cividis steps, dark → light, for poor / fair / good / excellent. */
export const SUITABILITY_COLORS = ["#00224e", "#575c6d", "#a59c74", "#fee838"] as const;
export const SUITABILITY_LABELS = ["Poor", "Fair", "Good", "Excellent"] as const;

/** Same rule as scripts/verify/reference_models.py: 25-point bins on the 0–100 score. */
export function suitabilityClass(score: number | null | undefined): -1 | 0 | 1 | 2 | 3 {
  if (score == null || !Number.isFinite(score)) return -1;
  const s = score / 100;
  return (s < .25 ? 0 : s < .5 ? 1 : s < .75 ? 2 : 3);
}

const wrap = (deg: number) => ((deg % 360) + 360) % 360;
const delta = (a: number, b: number) => ((b - a + 540) % 360) - 180;

/** Conservative adjacent-bin maximum, periodic across north (matches the backend). */
export function horizonAt(profile: number[], azimuthDeg: number): number {
  const n = profile.length;
  if (!n) return 0;
  const lo = Math.floor((wrap(azimuthDeg) * n) / 360) % n;
  return Math.max(profile[lo], profile[(lo + 1) % n]);
}

/** The sampled ray that sets the horizon at an azimuth, i.e. the terrain that blocks a body there. */
export function blockerAt(horizon: HorizonPoint[], azimuthDeg: number): HorizonPoint | null {
  const n = horizon.length;
  if (!n) return null;
  const lo = Math.floor((wrap(azimuthDeg) * n) / 360) % n;
  const a = horizon[lo], b = horizon[(lo + 1) % n];
  return a.elevation_deg >= b.elevation_deg ? a : b;
}

export interface PathPoint { azimuth: number; elevation: number; index: number }
export interface PathSegment { visible: boolean; points: PathPoint[] }

/**
 * Split a body's track into runs that share one visibility state.
 * The transition sample is repeated at the start of the next run so drawn
 * runs touch. With `splitAtWrap` a run also breaks where azimuth crosses
 * north, which a flat 0–360° panorama needs and a 3D dome does not.
 */
export function visibilitySegments(timeline: TimeSample[], body: Body, { step = 1, splitAtWrap = false } = {}): PathSegment[] {
  const segments: PathSegment[] = [];
  const last = timeline.length - 1;
  const vis = timeline.map(sample => (body === "sun" ? sample.sun_visible : sample.earth_visible));
  let current: PathSegment | null = null;
  for (let i = 0; i <= last; i++) {
    const sample = timeline[i];
    const point = {
      azimuth: body === "sun" ? sample.sun_azimuth_deg : sample.earth_azimuth_deg,
      elevation: body === "sun" ? sample.sun_elevation_deg : sample.earth_elevation_deg,
      index: i,
    };
    // Thin long windows, but always keep both samples around a change and the final sample.
    const nearChange = (i > 0 && vis[i] !== vis[i - 1]) || (i < last && vis[i] !== vis[i + 1]);
    if (!(i % step === 0 || i === last || nearChange)) continue;
    const previous = current as PathSegment | null;
    const tail: PathPoint | undefined = previous ? previous.points[previous.points.length - 1] : undefined;
    const changed: boolean = previous !== null && previous.visible !== vis[i];
    const wrapped: boolean = splitAtWrap && tail !== undefined && Math.abs(point.azimuth - tail.azimuth) > 180;
    if (!current || changed || wrapped) {
      current = { visible: vis[i], points: changed && !wrapped && tail ? [tail] : [] };
      segments.push(current);
    }
    current.points.push(point);
  }
  return segments.filter(segment => segment.points.length > 1 || segments.length === 1);
}

export interface SkyEvent { body: Body; type: "rise" | "set"; time_utc: string; index: number }

/** Every rise/set in the window. The time is the bracket midpoint (±half a sample). */
export function skyEvents(timeline: TimeSample[]): SkyEvent[] {
  const events: SkyEvent[] = [];
  for (const body of ["sun", "earth"] as const) {
    for (let i = 1; i < timeline.length; i++) {
      const before = body === "sun" ? timeline[i - 1].sun_visible : timeline[i - 1].earth_visible;
      const after = body === "sun" ? timeline[i].sun_visible : timeline[i].earth_visible;
      if (before === after) continue;
      const t = (Date.parse(timeline[i - 1].time_utc) + Date.parse(timeline[i].time_utc)) / 2;
      events.push({ body, type: after ? "rise" : "set", time_utc: new Date(t).toISOString(), index: i });
    }
  }
  return events.sort((a, b) => Date.parse(a.time_utc) - Date.parse(b.time_utc));
}

export interface Countdown { body: Body; type: "rise" | "set"; hours: number; label: string }

/** What happens next to a body after `fromUtc`, as plain words ("Sunset in 2 d 4 h"). */
export function nextChange(timeline: TimeSample[], fromUtc: string, body: Body): Countdown | null {
  const from = Date.parse(fromUtc);
  const event = skyEvents(timeline).find(e => e.body === body && Date.parse(e.time_utc) > from);
  if (!event) return null;
  const hours = (Date.parse(event.time_utc) - from) / 3_600_000;
  const noun = body === "sun" ? (event.type === "set" ? "Sunset" : "Sunrise") : (event.type === "set" ? "Earthset" : "Earthrise");
  return { body, type: event.type, hours, label: `${noun} in ${formatDuration(hours)}` };
}

export function formatDuration(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 24) {
    const h = Math.floor(hours), m = Math.round((hours - h) * 60);
    return m === 60 ? `${h + 1} h` : m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(hours / 24), h = Math.round(hours - d * 24);
  return h === 24 ? `${d + 1} d` : h ? `${d} d ${h} h` : `${d} d`;
}

/** Steady wording for a body's state for the whole window when it never changes. */
export function steadyState(timeline: TimeSample[], body: Body): string | null {
  const states = new Set(timeline.map(s => (body === "sun" ? s.sun_visible : s.earth_visible)));
  if (states.size !== 1) return null;
  const [visible] = [...states];
  return body === "sun" ? (visible ? "Sunlit all window" : "Dark all window") : (visible ? "Earth in view all window" : "Earth hidden all window");
}

/**
 * Display exaggeration for elevations in the dome. At the pole the Sun and the
 * ridge both sit within a few degrees of the horizon, which is unreadable at 1×.
 * Ordering (body above or below ridge) is preserved because everything scales together.
 */
export function elevationExaggeration(site: Pick<Candidate, "horizon" | "timeline">, targetDeg = 24): number {
  let max = 1;
  for (const h of site.horizon) max = Math.max(max, Math.abs(h.elevation_deg));
  for (const s of site.timeline) max = Math.max(max, Math.abs(s.sun_elevation_deg), Math.abs(s.earth_elevation_deg));
  return Math.max(1, Math.min(6, Math.floor(targetDeg / max) || 1));
}

/** Local sky direction: east +X, up +Y, north −Z (same basis as the existing scenes). */
export function skyDirection(azimuthDeg: number, elevationDeg: number, exaggeration = 1): [number, number, number] {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = Math.atan(Math.tan((Math.max(-89, Math.min(89, elevationDeg)) * Math.PI) / 180) * exaggeration);
  return [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)];
}

/** Index of the sample at or before `timeUtc` (timelines share the mission window's grid). */
export function sampleIndexAt(timeline: TimeSample[], timeUtc: string): number {
  const t = Date.parse(timeUtc);
  let lo = 0, hi = timeline.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Date.parse(timeline[mid].time_utc) <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * Unit horizontal vector for a local azimuth in projected metres
 * (south polar stereographic, lon_0 = 0: x = ρ·sin λ, y = ρ·cos λ).
 * Local north points away from the pole, local east toward increasing longitude.
 */
export function groundDirection(longitudeDeg: number, azimuthDeg: number): [number, number] {
  const lon = (longitudeDeg * Math.PI) / 180, az = (azimuthDeg * Math.PI) / 180;
  const east: [number, number] = [Math.cos(lon), -Math.sin(lon)];
  const north: [number, number] = [Math.sin(lon), Math.cos(lon)];
  return [Math.sin(az) * east[0] + Math.cos(az) * north[0], Math.sin(az) * east[1] + Math.cos(az) * north[1]];
}

export { delta as azimuthDelta };
