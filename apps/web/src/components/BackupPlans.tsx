import { useEffect, useMemo, useState } from "react";
import type { MapCandidate, SearchResponse } from "../lib/types";
import type { Scenario } from "../lib/scenarios";
import { coordinate, hours, percent } from "../lib/format";
import { queueFetch } from "../lib/queue-fetch";
import "./backup-plans.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";
type Metrics = { illumination_fraction: number; earth_visibility_fraction: number; longest_darkness_hours: number; longest_blackout_hours: number };
interface Evaluation { metrics: Metrics; constraint_status: { passes: boolean; region_pass?: boolean; terrain_pass: boolean; temporal_pass: boolean } }
interface ScenarioAnalysis {
  baseline: Evaluation; shifted: Evaluation;
  neighbors: { site: { id: string; latitude_deg: number; longitude_deg_east: number; slope_deg: number }; distance_m: number; metrics: Metrics; constraint_status: Evaluation["constraint_status"] }[];
  neighbor_count_total: number;
}

async function analyzeScenario(row: Scenario, delayHours: number, offsetRadiusM: number, signal: AbortSignal) {
  const response = await queueFetch(`${API_BASE}/scenarios/analyze`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal,
    body: JSON.stringify({ request: row.request, site_id: row.site.id, delay_hours: delayHours, offset_radius_m: offsetRadiusM, include_sampling_sensitivity: false }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.detail === "string" ? body.detail : body.detail?.message ?? `Scenario unavailable (${response.status})`);
  return body as ScenarioAnalysis;
}

function Delta({ before, after, format, higher }: { before: number; after: number; format: (n: number) => string; higher: boolean }) {
  const change = after - before;
  const same = format(after) === format(before);
  const better = higher ? change > 0 : change < 0;
  return <span className={same ? "" : better ? "backup-better" : "backup-worse"}>{format(after)}{!same && <small>{better ? "▲" : "▼"} from {format(before)}</small>}</span>;
}

function Verdict({ status }: { status: Evaluation["constraint_status"] }) {
  return <p className={`backup-verdict ${status.passes ? "ok" : "short"}`}>{status.passes ? "Still meets every mission limit" : "Falls short of your mission limits"}</p>;
}

function MetricList({ before, after }: { before: Metrics; after: Metrics }) {
  return <dl className="backup-metrics">
    <div><dt>Sunlight</dt><dd><Delta before={before.illumination_fraction} after={after.illumination_fraction} format={percent} higher /></dd></div>
    <div><dt>Earth in view</dt><dd><Delta before={before.earth_visibility_fraction} after={after.earth_visibility_fraction} format={percent} higher /></dd></div>
    <div><dt>Longest night</dt><dd><Delta before={before.longest_darkness_hours} after={after.longest_darkness_hours} format={hours} higher={false} /></dd></div>
  </dl>;
}

function pickSite(points: MapCandidate[], chosen: Scenario, score: (point: MapCandidate) => number, keep: (point: MapCandidate) => boolean) {
  let best: MapCandidate | undefined;
  for (const point of points) {
    if (point.id === chosen.site.id || !keep(point)) continue;
    if (!best || score(point) > score(best) || (score(point) === score(best) && point.score > best.score)) best = point;
  }
  return best;
}

/**
 * Plan B for the chosen site: what happens if launch slips or the lander misses
 * its aim point (re-computed by the backend for this site), and the best
 * already-ranked site to fall back to for a few common problems.
 */
export function BackupPlans({ chosen, label, result, switching, onSwitch }: {
  chosen: Scenario; label: string; result: SearchResponse; switching: string | null; onSwitch: (id: string) => void;
}) {
  const [day, setDay] = useState<ScenarioAnalysis | null>(null);
  const [week, setWeek] = useState<ScenarioAnalysis | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    setDay(null); setWeek(null); setError("");
    (async () => {
      try {
        setDay(await analyzeScenario(chosen, 24, 500, abort.signal));
        setWeek(await analyzeScenario(chosen, 72, 0, abort.signal));
      } catch (reason) { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "Scenario unavailable."); }
    })();
    return () => abort.abort();
  }, [chosen.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const site = chosen.site;
  const points = result.map_candidates ?? [];
  const distance = (point: MapCandidate) => Math.hypot(point.x_m - site.x_m, point.y_m - site.y_m) / 1000;
  const sites = useMemo(() => {
    const own = points.find(point => point.id === site.id);
    const baseScore = own?.score ?? site.score;
    return [
      { id: "power", title: "Need more power", issue: "Panels or batteries come in under spec.",
        pick: pickSite(points, chosen, point => point.illumination_fraction, point => point.illumination_fraction > site.metrics.illumination_fraction + .005) },
      { id: "contact", title: "Need more Earth contact", issue: "The comms link budget turns out tighter.",
        pick: pickSite(points, chosen, point => point.earth_visibility_fraction, point => point.earth_visibility_fraction > site.metrics.earth_visibility_fraction + .005) },
      { id: "terrain", title: "Hazard found at the site", issue: "Orbital imaging shows steeper ground than expected.",
        pick: pickSite(points, chosen, point => -point.slope_deg, point => point.slope_deg < site.slope_deg - .5 && point.score >= baseScore - 10) },
    ];
  }, [points, chosen, site, distance]); // eslint-disable-line react-hooks/exhaustive-deps

  const neighbors = day?.neighbors ?? [];
  const failingRows = neighbors.filter(row => !row.constraint_status.passes);
  const failing = failingRows.length;
  // Worst case: the closest point that breaks a limit, otherwise the least sunlit neighbor.
  const worst = failingRows[0] ?? neighbors.reduce<typeof neighbors[number] | undefined>((low, row) => !low || row.metrics.illumination_fraction < low.metrics.illumination_fraction ? row : low, undefined);
  const why = worst && !worst.constraint_status.passes
    ? !worst.constraint_status.terrain_pass ? `too steep (${worst.site.slope_deg.toFixed(1)}° slope)`
      : !worst.constraint_status.temporal_pass ? "misses a sunlight or Earth-contact limit" : "outside your search area"
    : null;
  const safest = neighbors.filter(row => row.constraint_status.passes)
    .reduce<typeof neighbors[number] | undefined>((best, row) => !best || row.metrics.illumination_fraction > best.metrics.illumination_fraction ? row : best, undefined);

  return <section className="backup-plans" aria-labelledby="backup-title">
    <header className="backup-chosen glass-surface">
      <div>
        <p className="backup-kicker">Your site</p>
        <h2 id="backup-title">{label}</h2>
        <p>{coordinate(site.latitude_deg, site.longitude_deg_east)} · {site.elevation_m.toFixed(0)} m · slope {site.slope_deg.toFixed(1)}°</p>
      </div>
      <dl className="backup-metrics">
        <div><dt>Sunlight</dt><dd>{percent(site.metrics.illumination_fraction)}</dd></div>
        <div><dt>Earth in view</dt><dd>{percent(site.metrics.earth_visibility_fraction)}</dd></div>
        <div><dt>Longest night</dt><dd>{hours(site.metrics.longest_darkness_hours)}</dd></div>
        {site.power && <div><dt>Energy</dt><dd>{(site.power.energy_wh / 1000).toFixed(2)} kWh</dd></div>}
      </dl>
    </header>

    <h3 className="backup-heading">If something goes wrong</h3>
    {error && <p className="guide-error" role="alert">{error}</p>}
    <div className="backup-grid">
      <article className="backup-card glass-surface">
        <h4>Launch slips a day</h4>
        <p className="backup-issue">Same site, mission window 24 hours later.</p>
        {day ? <><MetricList before={day.baseline.metrics} after={day.shifted.metrics} /><Verdict status={day.shifted.constraint_status} /></> : !error && <p className="backup-loading" role="status">Recomputing with SPICE…</p>}
      </article>
      <article className="backup-card glass-surface">
        <h4>Launch slips three days</h4>
        <p className="backup-issue">Same site, mission window 72 hours later.</p>
        {week ? <><MetricList before={week.baseline.metrics} after={week.shifted.metrics} /><Verdict status={week.shifted.constraint_status} /></> : !error && <p className="backup-loading" role="status">{day ? "Recomputing with SPICE…" : "Waiting…"}</p>}
      </article>
      <article className="backup-card glass-surface">
        <h4>Lands off target</h4>
        <p className="backup-issue">Touchdown anywhere within 500 m of the aim point.</p>
        {day ? neighbors.length ? <>
          <p>{neighbors.length} prepared points within 500 m · {failing ? `${failing} fall short of your limits` : "all meet your limits"}.</p>
          {worst && <MetricList before={day.baseline.metrics} after={worst.metrics} />}
          {worst && <p className="field-hint">Worst case shown: {worst.distance_m.toFixed(0)} m away{why ? `, ${why}` : ""}.</p>}
          {failing > 0 && safest && <button type="button" className="secondary-button" disabled={!!switching} onClick={() => onSwitch(safest.site.id)}>
            {switching === safest.site.id ? "Loading…" : `Aim at the strongest neighbor · ${(safest.distance_m).toFixed(0)} m away`}</button>}
        </> : <p>No other prepared points within 500 m.</p> : !error && <p className="backup-loading" role="status">Checking neighbors…</p>}
      </article>
      {sites.map(option => <article key={option.id} className="backup-card glass-surface">
        <h4>{option.title}</h4>
        <p className="backup-issue">{option.issue}</p>
        {option.pick ? <>
          <p>Best ranked alternative: {coordinate(option.pick.latitude_deg ?? 0, option.pick.longitude_deg_east ?? 0)} · {distance(option.pick).toFixed(1)} km away</p>
          <dl className="backup-metrics">
            <div><dt>Sunlight</dt><dd><Delta before={site.metrics.illumination_fraction} after={option.pick.illumination_fraction} format={percent} higher /></dd></div>
            <div><dt>Earth in view</dt><dd><Delta before={site.metrics.earth_visibility_fraction} after={option.pick.earth_visibility_fraction} format={percent} higher /></dd></div>
            <div><dt>Slope</dt><dd><Delta before={site.slope_deg} after={option.pick.slope_deg} format={value => `${value.toFixed(1)}°`} higher={false} /></dd></div>
          </dl>
          <button type="button" className="secondary-button" disabled={!!switching} onClick={() => onSwitch(option.pick!.id)}>{switching === option.pick.id ? "Loading…" : "Switch to this site"}</button>
        </> : <p>Your site is already the best in this search for this.</p>}
      </article>)}
    </div>
    <p className="backup-source">Slip and off-target cases are recomputed for this site with NASA/NAIF SPICE ephemerides and LOLA horizons. Alternatives come from the sites ranked in this search.</p>
  </section>;
}
