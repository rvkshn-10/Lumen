import type { TimeSample } from "./types";

/**
 * Scene-parity hook (Track B gate). In development builds, or with `?parity`
 * in the URL, `window.__lumenScene.dump()` returns what each mounted 3D view is
 * drawing right now. `scripts/verify/lumen_verify.py --scene-dump` compares it
 * with the API timeline, so a picture that disagrees with the numbers fails CI.
 */
export interface SceneDumpSample {
  view: string;
  site_id: string;
  time_utc: string;
  sun_azimuth_deg: number;
  sun_elevation_deg: number;
  earth_azimuth_deg: number;
  earth_elevation_deg: number;
  sun_horizon_deg: number;
  earth_horizon_deg: number;
  sun_visible: boolean;
  earth_visible: boolean;
}

type Provider = () => SceneDumpSample[];
const providers = new Map<string, Provider>();

function enabled() {
  if (typeof window === "undefined") return false;
  return import.meta.env.DEV || new URLSearchParams(window.location.search).has("parity");
}

export function registerSceneDump(key: string, provider: Provider): () => void {
  if (!enabled()) return () => {};
  providers.set(key, provider);
  const target = window as unknown as { __lumenScene?: { dump: () => { samples: SceneDumpSample[] } } };
  target.__lumenScene ??= { dump: () => ({ samples: [...providers.values()].flatMap(get => get()) }) };
  return () => { providers.delete(key); };
}

/**
 * Build one dump row from the values a view actually uses to draw. Views pass
 * the horizon they drew at each body's azimuth and the state they styled with,
 * not a fresh copy of the API sample, so a drawing bug shows up in the dump.
 */
export function dumpRow(view: string, siteId: string, sample: TimeSample, drawn: {
  sunHorizon: number; earthHorizon: number; sunVisible: boolean; earthVisible: boolean;
}): SceneDumpSample {
  return {
    view, site_id: siteId, time_utc: sample.time_utc,
    sun_azimuth_deg: sample.sun_azimuth_deg, sun_elevation_deg: sample.sun_elevation_deg,
    earth_azimuth_deg: sample.earth_azimuth_deg, earth_elevation_deg: sample.earth_elevation_deg,
    sun_horizon_deg: drawn.sunHorizon, earth_horizon_deg: drawn.earthHorizon,
    sun_visible: drawn.sunVisible, earth_visible: drawn.earthVisible,
  };
}
