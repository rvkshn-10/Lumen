import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { Candidate, TerrainData } from "../lib/types";
import { coordinate, hours, percent, utcTime } from "../lib/format";
import { sampleIndexAt } from "../lib/mission-window";
import { siteFrame, useLocalTerrain } from "../lib/local-terrain";
import { PlanningDialog } from "./PlanningEvidence";
import "./site-details.css";

const SkyScene = lazy(() => import("./SkyScene").then(module => ({ default: module.SkyScene })));
const TerrainScene = lazy(() => import("./TerrainScene").then(module => ({ default: module.TerrainScene })));

const speeds = [
  { label: "1 h / s", hoursPerSecond: 1 },
  { label: "6 h / s", hoursPerSecond: 6 },
  { label: "1 day / s", hoursPerSecond: 24 },
] as const;

function runs(site: Candidate, key: "sun_visible" | "earth_visible", start: number, end: number) {
  const out: { from: number; to: number; on: boolean }[] = [];
  site.timeline.forEach((sample, index) => {
    const from = Date.parse(sample.time_utc), to = Date.parse(site.timeline[index + 1]?.time_utc ?? new Date(end).toISOString());
    const on = sample[key];
    const last = out[out.length - 1];
    if (last && last.on === on) last.to = to; else out.push({ from, to, on });
  });
  return out.map(run => ({ ...run, left: (run.from - start) * 100 / (end - start), width: (run.to - run.from) * 100 / (end - start) }));
}

/**
 * The view from one site across the mission: its LOLA skyline with the Sun and
 * Earth moving through the sky, and the local 80 m terrain with live sight
 * lines. Every position comes from the backend's SPICE timeline for this site.
 */
export function SiteDetails({ site, label, start: windowStart, end: windowEnd, overview, onClose }: {
  site: Candidate; label: string; start: string; end: string; overview: TerrainData | null; onClose: () => void;
}) {
  const start = Date.parse(windowStart), end = Date.parse(windowEnd);
  const timeline = site.timeline;
  const [time, setTime] = useState(start);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [view, setView] = useState<"sky" | "terrain">("sky");
  // Only the polar cap is in the 80 m south-pole DEM; elsewhere keep the terrain the search returned.
  const frame = useMemo(() => site.latitude_deg <= -86.9 ? siteFrame([site], 4) : null, [site]);
  const terrain = useLocalTerrain(frame, overview);
  const local = terrain !== overview;
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let previous = performance.now();
    const step = (now: number) => {
      const elapsed = now - previous;
      if (elapsed >= 50) {
        previous = now;
        setTime(current => {
          const next = current + elapsed / 1000 * speeds[speed].hoursPerSecond * 3_600_000;
          if (next >= end) { setPlaying(false); return end; }
          return next;
        });
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, end]);

  const index = Math.max(0, Math.min(timeline.length - 1, sampleIndexAt(timeline, time)));
  const sample = timeline[index];
  const sunRuns = useMemo(() => runs(site, "sun_visible", start, end), [site, start, end]);
  const earthRuns = useMemo(() => runs(site, "earth_visible", start, end), [site, start, end]);
  const playhead = (time - start) * 100 / (end - start);
  if (!sample) return <PlanningDialog title={`${label} · details`} onClose={onClose}><p>No timeline samples are available for this site.</p></PlanningDialog>;

  return <PlanningDialog title={`${label} · view from the site`} onClose={onClose}>
    <p className="site-details-sub">{coordinate(site.latitude_deg, site.longitude_deg_east)} · {site.elevation_m.toFixed(0)} m · slope {site.slope_deg.toFixed(1)}°</p>
    <dl className="site-details-facts">
      <div><dt>Sunlight</dt><dd>{percent(site.metrics.illumination_fraction)}</dd></div>
      <div><dt>Earth in view</dt><dd>{percent(site.metrics.earth_visibility_fraction)}</dd></div>
      <div><dt>Longest night</dt><dd>{hours(site.metrics.longest_darkness_hours)}</dd></div>
      <div><dt>Longest Earth blackout</dt><dd>{hours(site.metrics.longest_blackout_hours)}</dd></div>
    </dl>

    <div className="site-details-controls">
      <button type="button" className="primary-button site-details-play" onClick={() => {
        if (!playing && time >= end) setTime(start);
        setPlaying(value => !value);
      }} aria-label={playing ? "Pause" : "Play the mission"}>{playing ? "Pause" : time >= end ? "Replay" : "Play"}</button>
      <label className="field site-details-speed">Speed<select value={speed} onChange={event => setSpeed(Number(event.target.value))}>
        {speeds.map((option, position) => <option key={option.label} value={position}>{option.label}</option>)}
      </select></label>
      <div className="site-details-tabs" role="group" aria-label="View">
        <button type="button" aria-pressed={view === "sky"} onClick={() => setView("sky")}>From the site</button>
        <button type="button" aria-pressed={view === "terrain"} onClick={() => setView("terrain")}>Terrain &amp; sight lines</button>
      </div>
    </div>

    <div className="site-details-scene">
      <Suspense fallback={<p role="status">Loading view…</p>}>
        {view === "sky"
          ? <SkyScene site={site} sample={sample} />
          : terrain ? <TerrainScene terrain={terrain} candidates={[site]} selected={site.id} onSelect={() => {}} mode="terrain" layer="terrain"
            mapCandidates={[]} psr={null} features={[]} sample={sample} /> : <p>Terrain unavailable.</p>}
      </Suspense>
      <div className="site-details-status" aria-live="off">
        <span className={sample.sun_visible ? "on sun" : "off"}>Sun {sample.sun_visible ? "in line of sight" : "blocked"} · {sample.sun_elevation_deg.toFixed(2)}°</span>
        <span className={sample.earth_visible ? "on earth" : "off"}>Earth {sample.earth_visible ? "in line of sight" : "blocked"} · {sample.earth_elevation_deg.toFixed(2)}°</span>
      </div>
    </div>
    {view === "terrain" && <p className="field-hint">{local ? "NASA LOLA 80 m/px terrain around the site · height 1.5×" : "Loading NASA LOLA 80 m/px terrain… showing the 2 km overview"}</p>}

    <div className="site-details-timeline" aria-label="Line of sight across the mission">
      {([["Sun", sunRuns, "sun"], ["Earth", earthRuns, "earth"]] as const).map(([name, rows, body]) => <div className="site-details-strip" key={name}>
        <span>{name}</span>
        <div>{rows.map(run => <i key={run.from} className={run.on ? body : "blocked"} style={{ left: `${run.left}%`, width: `${run.width}%` }} />)}
          <b style={{ left: `${playhead}%` }} aria-hidden="true" /></div>
      </div>)}
      <label className="field site-details-scrub">
        <span><time dateTime={sample.time_utc}>{utcTime(new Date(time).toISOString())}</time></span>
        <input type="range" min={start} max={end} step={5 * 60_000} value={time} aria-label="Mission time"
          aria-valuetext={utcTime(new Date(time).toISOString())}
          onChange={event => { setPlaying(false); setTime(Number(event.target.value)); }} />
      </label>
      <div className="site-details-axis"><span>{utcTime(windowStart)}</span><span>{utcTime(windowEnd)}</span></div>
    </div>
    <p className="site-details-source">Sun and Earth positions: NASA/NAIF SPICE (DE440) for this site, every 5 minutes. Skyline and terrain: NASA LOLA. Line of sight means the Sun’s upper edge or Earth’s center clears the terrain horizon.</p>
  </PlanningDialog>;
}
