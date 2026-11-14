import { useEffect, useMemo } from "react";
import type { Candidate, TimeSample } from "../lib/types";
import {
  BLOCKED_COLOR, BODY_COLORS, horizonAt, nextChange, skyEvents,
  steadyState, visibilitySegments, type Body,
} from "../lib/sky-geometry";
import { dumpRow, registerSceneDump } from "../lib/scene-parity";

/**
 * The 360° skyline unrolled: azimuth across, elevation up (stretched so a few
 * degrees are readable). Sun and Earth tracks are solid while in view and
 * dashed grey while terrain hides them; ▼ marks each set and ▲ each rise.
 * It shows the same data as the 3D sky, for people who would rather not orbit a camera.
 */
export function HorizonPanorama({ site, sample }: { site: Candidate; sample: TimeSample | undefined }) {
  const profile = useMemo(() => site.horizon.map(h => h.elevation_deg), [site]);
  const { minimum, maximum } = useMemo(() => {
    const values = [...profile, ...site.timeline.flatMap(s => [s.sun_elevation_deg, s.earth_elevation_deg])];
    return { minimum: Math.min(-2, ...values) - .6, maximum: Math.max(4, ...values) + .8 };
  }, [profile, site.timeline]);
  const W = 670, left = 40, right = 642, top = 22, bottom = 176;
  const x = (az: number) => left + (((az % 360) + 360) % 360 / 360) * (right - left);
  /** Unwrapped: 360° maps to the right edge (the ridge outline must close on the right, not jump back left). */
  const xr = (az: number) => left + (az / 360) * (right - left);
  const y = (el: number) => bottom - ((el - minimum) / (maximum - minimum)) * (bottom - top);

  const ridge = useMemo(() => {
    const pts = Array.from({ length: 361 }, (_, az) => `${xr(az).toFixed(1)},${y(horizonAt(profile, az)).toFixed(1)}`);
    return { line: `M${pts.join(" L")}`, fill: `M${pts.join(" L")} L${right},${bottom} L${left},${bottom} Z` };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, minimum, maximum]);

  const tracks = useMemo(() => (["sun", "earth"] as const).map(body => ({
    body,
    segments: visibilitySegments(site.timeline, body, { step: Math.max(1, Math.floor(site.timeline.length / 400)), splitAtWrap: true }),
  })), [site.timeline]);
  const events = useMemo(() => skyEvents(site.timeline), [site.timeline]);

  const sunHorizon = sample ? horizonAt(profile, sample.sun_azimuth_deg) : 0;
  const earthHorizon = sample ? horizonAt(profile, sample.earth_azimuth_deg) : 0;
  useEffect(() => {
    if (!sample) return;
    return registerSceneDump(`panorama:${site.id}`, () => [dumpRow("panorama", site.id, sample, {
      sunHorizon, earthHorizon, sunVisible: sample.sun_visible, earthVisible: sample.earth_visible,
    })]);
  }, [site.id, sample, sunHorizon, earthHorizon]);

  if (!profile.length) return <p className="muted">Horizon unavailable.</p>;
  const ticks = [minimum, 0, maximum].map(v => Math.round(v));
  const line = (body: Body) => {
    if (!sample) return null;
    return nextChange(site.timeline, sample.time_utc, body)?.label ?? steadyState(site.timeline, body);
  };
  return (
    <figure className="horizon-panorama">
      <svg className="horizon-chart" viewBox={`0 0 ${W} 214`} role="img"
        aria-label="360 degree terrain skyline with the Sun and Earth tracks. Solid where in view, dashed where terrain blocks them.">
        {[0, 90, 180, 270, 360].map((az, i) => (
          <g key={az}>
            <line x1={xr(az)} x2={xr(az)} y1={top} y2={bottom} stroke="#2a3435" strokeDasharray="2 5" />
            <text x={xr(az)} y="201" textAnchor="middle">{["N 0°", "E 90°", "S 180°", "W 270°", "N 360°"][i]}</text>
          </g>
        ))}
        {ticks.map((el, i) => (
          <g key={i}>
            <line x1={left} x2={right} y1={y(el)} y2={y(el)} stroke={el === 0 ? "#3b4a47" : "#22302e"} />
            <text x={left - 8} y={y(el) + 4} textAnchor="end">{el}°</text>
          </g>
        ))}
        <path d={ridge.fill} fill="#2e3936" fillOpacity=".72" />
        <path d={ridge.line} fill="none" stroke="#a9c6a9" strokeWidth="1.6" />
        {tracks.map(({ body, segments }) => segments.map((segment, i) => (
          <polyline key={`${body}-${i}`} fill="none"
            points={segment.points.map(p => `${x(p.azimuth).toFixed(1)},${y(p.elevation).toFixed(1)}`).join(" ")}
            stroke={segment.visible ? BODY_COLORS[body] : BLOCKED_COLOR} strokeWidth={segment.visible ? 1.9 : 1.2}
            strokeDasharray={segment.visible ? undefined : "4 4"} opacity={segment.visible ? .9 : .75} />
        )))}
        {events.map((event, i) => {
          const s = site.timeline[event.index];
          const az = event.body === "sun" ? s.sun_azimuth_deg : s.earth_azimuth_deg;
          const el = event.body === "sun" ? s.sun_elevation_deg : s.earth_elevation_deg;
          const cx = x(az), cy = y(el);
          const d = event.type === "set" ? `M${cx - 4},${cy - 9} L${cx + 4},${cy - 9} L${cx},${cy - 3} Z` : `M${cx - 4},${cy - 3} L${cx + 4},${cy - 3} L${cx},${cy - 9} Z`;
          return <path key={i} d={d} fill={BODY_COLORS[event.body]}>
            <title>{`${event.body === "sun" ? (event.type === "set" ? "Sunset" : "Sunrise") : (event.type === "set" ? "Earthset" : "Earthrise")} ${event.time_utc.slice(0, 16).replace("T", " ")} UTC`}</title>
          </path>;
        })}
        {sample && (["sun", "earth"] as const).map(body => {
          const az = body === "sun" ? sample.sun_azimuth_deg : sample.earth_azimuth_deg;
          const el = body === "sun" ? sample.sun_elevation_deg : sample.earth_elevation_deg;
          const visible = body === "sun" ? sample.sun_visible : sample.earth_visible;
          return <circle key={body} cx={x(az)} cy={y(el)} r="5" fill={visible ? BODY_COLORS[body] : "#1a2221"}
            stroke={visible ? "#141b1a" : BODY_COLORS[body]} strokeWidth="2" strokeDasharray={visible ? undefined : "2 2"} />;
        })}
      </svg>
      {sample && <figcaption className="panorama-countdowns">
        <span className="sun-color">☀ {line("sun")}</span>
        <span className="earth-color">⊕ {line("earth")}</span>
        <span className="muted">Heights stretched · ▼ set ▲ rise · dashed = behind terrain</span>
      </figcaption>}
    </figure>
  );
}
