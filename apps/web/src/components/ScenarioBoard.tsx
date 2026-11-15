import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import { coordinate, downloadTimelineCsv, hours, percent, utcRange, utcTime } from "../lib/format";
import { MAX_SCENARIOS, alternativeScenario, batteryMargin, loadScenario, nextEvent, sampledEvents, scenarioKey, scenarioShareHash, scenarioWindow, visibilityRuns } from "../lib/scenarios";
import type { Candidate, TerrainData } from "../lib/types";
import { COMPARE_COLORS } from "../lib/sky-geometry";
import { COMPARE_LIMIT, compareSiteLabel } from "../lib/compare-sites";
import type { Alternative, Audience, LunarEvent, Scenario, ScenarioResult } from "../lib/scenarios";
import { LaunchSlipComparison } from "./LaunchSlipComparison";
import { PoweredContactWindow } from "./PoweredContactWindow";
import { CutoffTerrainEvidence } from "./CutoffTerrainEvidence";
import { MissionWindowCheck } from "./MissionWindowCheck";
import { sampleIndexAt } from "../lib/mission-window";
import { HorizonReview } from "./HorizonReview";
import { CopilotExplanation } from "./CopilotExplanation";
import { PowerUse } from "./PowerUse";
import { siteFrame, useLocalTerrain } from "../lib/local-terrain";
import { CandidateResults } from "./CandidateResults";
import { Icon } from "./Icon";
import "./scenario-board.css";

const GlobeScene = lazy(() => import("./GlobeScene").then(module => ({ default: module.GlobeScene })));
const TerrainScene = lazy(() => import("./TerrainScene").then(module => ({ default: module.TerrainScene })));
const metrics = [
  { key: "illumination_fraction", label: "Sunlight", format: percent, higher: true, meaning: "The share of the window when any part of the Sun clears the terrain, like sunlight over a ridge." },
  { key: "earth_visibility_fraction", label: "Earth in view", format: percent, higher: true, meaning: "The share of the window when Earth's center clears the terrain, like a direct sight line over a wall." },
  { key: "longest_darkness_hours", label: "Longest night", format: hours, higher: false, meaning: "The longest continuous stretch of darkness, like the time between sunset and sunrise." },
  { key: "energy_wh", label: "Energy estimate", format: (n: number) => `${(n / 1000).toFixed(2)} kWh`, higher: true, meaning: "Energy generated across the window under the stated panel assumptions." },
] as const;
type Key = typeof metrics[number]["key"];
type Detail = "plain" | "engineer";
const exactFormat: Record<Key, (n: number) => string> = {
  illumination_fraction: n => `${(n * 100).toFixed(4)}%`,
  earth_visibility_fraction: n => `${(n * 100).toFixed(4)}%`,
  longest_darkness_hours: n => `${n.toFixed(3)} h`,
  energy_wh: n => `${(n / 1000).toFixed(4)} kWh`,
};
const plainMeaning: Record<Key, { more: string; less: string }> = {
  illumination_fraction: { more: "more time in sunlight, so more solar power", less: "less time in sunlight" },
  earth_visibility_fraction: { more: "Earth in view for longer, so more time to talk to mission control", less: "less time with Earth in view" },
  longest_darkness_hours: { more: "a longer night the batteries must cover", less: "a shorter worst-case night, so less battery is needed" },
  energy_wh: { more: "more energy from the same panel", less: "less energy from the same panel" },
};
function readDetail(): Detail {
  try { return localStorage.getItem("lumen-compare-detail") === "engineer" ? "engineer" : "plain"; } catch { return "plain"; }
}
const metricAttributes = (id: string, key: string, raw: number | string) => ({ "data-metric": `${id}:${key}`, "data-raw": raw });
const value = (row: Scenario, key: Key) => key === "energy_wh" ? row.site.power?.energy_wh : row.site.metrics[key];
const siteCoordinates = (row: Scenario) => coordinate(row.site.latitude_deg, row.site.longitude_deg_east);
const label = (row: Scenario) => row.label && !/^Site [A-D]$/.test(row.label)
  ? row.label : row.site.rank ? `Candidate ${row.site.rank}` : siteCoordinates(row);
const comparisonLabel = (row: Scenario, index: number) => `${compareSiteLabel(index)} · ${label(row)}`;

function Metric({ row, metric, exact = false }: { row: Scenario; metric: typeof metrics[number]; exact?: boolean }) {
  const number = value(row, metric.key);
  return number == null ? <span>Unavailable</span> : <span {...metricAttributes(row.site.id, metric.key, number)}>{(exact ? exactFormat[metric.key] : metric.format)(number)}</span>;
}

/** Plain-language summary of where the selected scenarios differ most. */
function KeyDifferences({ rows }: { rows: Scenario[] }) {
  const lines = metrics.flatMap(metric => {
    const entries = rows.flatMap((row, index) => {
      const number = value(row, metric.key);
      return number == null ? [] : [{ index, number }];
    });
    if (entries.length < 2) return [];
    const sorted = [...entries].sort((a, b) => metric.higher ? b.number - a.number : a.number - b.number);
    const best = sorted[0], worst = sorted.at(-1)!;
    if (metric.format(best.number) === metric.format(worst.number)) return [];
    const leader = compareSiteLabel(best.index), trailer = compareSiteLabel(worst.index);
    const meaning = metric.higher ? plainMeaning[metric.key].more : plainMeaning[metric.key].less;
    return [<li key={metric.key}><strong>{metric.label}:</strong> {leader} is ahead ({metric.format(best.number)} vs {metric.format(worst.number)} at {trailer}) — {meaning}.</li>];
  });
  return <section className="compare-reading" aria-label="How to read this comparison">
    <h3>How to read this</h3>
    <p>Each column is one scenario: a site and its mission dates. The highlighted value in each row is the best one. Rows that look the same are effectively tied.</p>
    {lines.length ? <ul>{lines}</ul> : <p>The selected scenarios give the same results on these measures. Try other sites or dates to see a difference.</p>}
    <p className="field-hint">Switch to Engineer view for exact values, units and model assumptions.</p>
  </section>;
}

type Cutoff = LunarEvent & { type: "sunset" | "earthset"; refined: boolean };

function EventCountdown({ row, type, clock, onInspect }: { row: Scenario; type: Cutoff["type"]; clock: number; onInspect: (cutoff: Cutoff) => void }) {
  const end = Date.parse(row.request.time_range.end_utc);
  const events = useMemo(() => row.site.events ?? sampledEvents(row.site.timeline), [row.site]);
  if (clock >= end) return <span>Window ended</span>;
  const event = nextEvent({ ...row.site, events }, type, clock);
  if (!row.site.events && !row.site.timeline.length) return <span>Unavailable</span>;
  if (!event || Date.parse(event.time_utc) >= end) return <span>None remaining</span>;
  const time = Date.parse(event.time_utc);
  const minutes = Math.max(0, Math.ceil((time - clock) / 60_000));
  const days = Math.floor(minutes / 1440), remaining = minutes % 1440;
  return <div className="scenario-event-cell"><span data-metric={row.site.events ? `${row.site.id}:${type}` : undefined} data-raw={row.site.events ? event.time_utc : undefined} title={`±${event.uncertainty_minutes} min`}>
    {row.site.events ? "" : "About "}{utcTime(event.time_utc)}<small>{minutes === 0 ? "At selected time" : `In ${days ? `${days} d ` : ""}${Math.floor(remaining / 60)} h ${remaining % 60} min`}</small>
  </span><button className="text-button" type="button" onClick={() => onInspect({ ...event, type, refined: row.site.events != null })}>Inspect {type}</button></div>;
}

function Timeline({ rows, start, end, clock, onInspect }: {
  rows: Scenario[]; start: number; end: number; clock: number;
  onInspect: (row: Scenario, cutoff: Cutoff) => void;
}) {
  const position = (time: number) => (time - start) * 100 / (end - start);
  return <section className="scenario-timeline" aria-label="Aligned site timelines">
    <p>{utcTime(new Date(start).toISOString())} to {utcTime(new Date(end).toISOString())} · Filled segments show visibility. Select a cutoff marker to inspect it.</p>
    {rows.map((row, index) => <div className="scenario-strip-row" key={row.key}>
      <strong>{comparisonLabel(row, index)} <small>{row.request.time_range.start_utc.slice(0, 10)}</small></strong>
      {(["sun_visible", "earth_visible"] as const).map((key, index) => {
        const runs = visibilityRuns(row.site, row.request, key);
        const title = index ? "Earth in view" : "Sunlight";
        const type = index ? "earthset" : "sunset";
        return <div key={key} className="scenario-strip-line"><span>{title}</span><div className="scenario-strip">
          {runs.map(run => <span aria-hidden="true" className={run.visible ? "visible" : "blocked"} key={run.start} style={{ left: `${position(run.start)}%`, width: `${position(run.end) - position(run.start)}%` }} />)}
          <span aria-hidden="true" className="scenario-clock-mark" style={{ left: `${position(clock)}%` }} />
          {(row.site.events ?? sampledEvents(row.site.timeline)).filter(event => event.type === type).map(event => {
            const tick = position(Date.parse(event.time_utc));
            if (tick < 0 || tick > 100) return null;
            return <button className="scenario-event" type="button" key={event.time_utc} style={{ left: `${tick}%` }}
              title={`Inspect ${type} · ${utcTime(event.time_utc)}`}
              aria-label={`Inspect ${comparisonLabel(row, index)} ${type} at ${utcTime(event.time_utc)}`}
              onClick={() => onInspect(row, { ...event, type, refined: row.site.events != null })} />;
          })}
        </div><span className="sr-only">{runs.filter(run => run.visible).map(run => `${utcTime(new Date(run.start).toISOString())} to ${utcTime(new Date(run.end).toISOString())}`).join("; ") || "No visible samples"}</span></div>;
      })}
    </div>)}
  </section>;
}

function Charts({ row, synthetic, targetTime, cutoff }: { row: Scenario; synthetic: boolean; targetTime?: number; cutoff?: Cutoff }) {
  const [inspectedTime, setInspectedTime] = useState<number>();
  const [dataTables, setDataTables] = useState<string[]>([]);
  const evidence = useRef<HTMLHeadingElement>(null);
  const timeline = row.site.timeline;
  const sampleIndex = Math.max(0, sampleIndexAt(timeline, inspectedTime ?? targetTime ?? Date.parse(row.request.time_range.start_utc)));
  const sample = timeline[sampleIndex];
  function inspectAt(time: number) {
    setInspectedTime(time);
    evidence.current?.focus();
  }
  const [capacity, setCapacity] = useState("2000"), [load, setLoad] = useState("150");
  const [area, setArea] = useState<string>(), [efficiency, setEfficiency] = useState<string>();
  const start = Date.parse(row.request.time_range.start_utc), end = Date.parse(row.request.time_range.end_utc);
  const power = row.site.power;
  const panelArea = area == null ? power?.assumptions.area_m2 ?? 0 : Number(area);
  const panelEfficiency = efficiency == null ? (power?.assumptions.efficiency ?? 0) * 100 : Number(efficiency);
  const factor = power && panelArea > 0 && panelEfficiency > 0 && panelEfficiency <= 100 && power.assumptions.area_m2 > 0 && power.assumptions.efficiency > 0
    ? panelArea * panelEfficiency / (100 * power.assumptions.area_m2 * power.assumptions.efficiency) : undefined;
  const margin = Number(capacity) >= 0 && capacity !== "" && Number(load) > 0 ? batteryMargin(Number(capacity), Number(load), row.site.metrics.longest_darkness_hours) : null;
  const elevations = timeline.map(point => ({ time_utc: point.time_utc, first: point.sun_elevation_deg, second: point.sun_horizon_deg }));
  const earthElevations = timeline.map(point => ({ time_utc: point.time_utc, first: point.earth_elevation_deg, second: point.earth_horizon_deg }));
  const watts = factor == null ? [] : power?.series.map(sample => ({ time_utc: sample.time_utc, first: sample.vertical_w * factor, second: sample.horizontal_w * factor })) ?? [];
  function plot(points: typeof elevations, title: string, first: string, second: string, unit: string,
    rawKeys?: readonly [string, string]) {
    if (!points.length) return <p>{title} unavailable for this analysis.</p>;
    const bounds = points.reduce(({ min, max }, point) => ({
      min: Math.min(min, point.first, point.second), max: Math.max(max, point.first, point.second),
    }), { min: 0, max: 0 });
    const min = bounds.min, max = Math.max(min + 1, bounds.max);
    function line(key: "first" | "second") {
      return points.map(point => `${(Date.parse(point.time_utc) - start) * 600 / (end - start)},${95 - (point[key] - min) * 90 / (max - min)}`).join(" ");
    }
    const horizon = unit === "°" ? `0,100 ${line("second")} ${(Date.parse(points.at(-1)!.time_utc) - start) * 600 / (end - start)},100` : "";
    return <figure className="scenario-chart"><figcaption>{title} · {first} (gold) · {second} (dashed blue)</figcaption>
      <div className="scenario-plot"><div><span>{max.toFixed(1)} {unit}</span><span>{min.toFixed(1)} {unit}</span></div><svg viewBox="0 0 600 100" preserveAspectRatio="none" role="img" aria-label={title}>
        {horizon && <polygon points={horizon} fill="#8bc8ed28" />}
        <polyline points={line("second")} stroke="#8bc8ed" strokeDasharray="5 4" />
        <polyline points={line("first")} stroke="#f6cc80" />
        {sample && unit === "°" && <line x1={(Date.parse(sample.time_utc) - start) * 600 / (end - start)}
          x2={(Date.parse(sample.time_utc) - start) * 600 / (end - start)} y1="0" y2="100" stroke="#e7f5ec" /> }
      </svg></div>
      <div className="scenario-chart-axis"><span>{utcTime(row.request.time_range.start_utc)}</span><span>{utcTime(row.request.time_range.end_utc)}</span></div>
      <details onToggle={event => {
        const open = event.currentTarget.open;
        setDataTables(current => open ? Array.from(new Set([...current, title])) : current.filter(name => name !== title));
      }}><summary>{title} data table</summary>{dataTables.includes(title) && <div className="table-scroll"><table className="comparison-table"><thead><tr><th scope="col">Time (UTC)</th><th scope="col">{first} ({unit})</th><th scope="col">{second} ({unit})</th></tr></thead>
        <tbody>{points.map(point => <tr key={point.time_utc} data-time-utc={point.time_utc}><th scope="row">{utcTime(point.time_utc)}</th><td {...(rawKeys ? metricAttributes(row.site.id, rawKeys[0], point.first) : {})}>{point.first.toFixed(2)}</td>
        <td {...(rawKeys ? metricAttributes(row.site.id, rawKeys[1], point.second) : {})}>{point.second.toFixed(2)}</td></tr>)}</tbody></table></div>}</details>
    </figure>;
  }
  return <section className="scenario-charts" aria-label={`${label(row)} charts`}>
    {cutoff && <CutoffTerrainEvidence site={row.site} type={cutoff.type} timeUtc={cutoff.time_utc}
      uncertaintyMinutes={cutoff.uncertainty_minutes} refined={cutoff.refined} onInspectSample={inspectAt} />}
    {plot(elevations, "Solar elevation", "Sun elevation", "Terrain horizon", "°", ["sun_elevation_deg", "sun_horizon_deg"])}
    {plot(earthElevations, "Earth elevation", "Earth center elevation", "Terrain horizon", "°", ["earth_elevation_deg", "earth_horizon_deg"])}
    {sample && <section className="horizon-sample">
      <h4 ref={evidence} tabIndex={-1}>Inspect the terrain horizon</h4>
      <label className="field">Horizon sample · {utcTime(sample.time_utc)}<input type="range" min="0" max={timeline.length - 1}
        value={sampleIndex} disabled={timeline.length < 2} aria-valuetext={utcTime(sample.time_utc)}
        onChange={event => setInspectedTime(Date.parse(timeline[Number(event.target.value)].time_utc))} /></label>
      <dl className="inspection-facts">
        <div><dt>Earth center · {sample.earth_visible ? "In view" : "Blocked"}</dt><dd>{sample.earth_elevation_deg.toFixed(3)}° elevation · {sample.earth_horizon_deg.toFixed(3)}° terrain horizon · {(sample.earth_elevation_deg - sample.earth_horizon_deg).toFixed(3)}° clearance</dd></div>
        <div><dt>Sun’s upper edge · {sample.sun_visible ? "Visible" : "Blocked"}</dt><dd>{sample.sun_elevation_deg.toFixed(3)}° center elevation · {sample.sun_horizon_deg.toFixed(3)}° terrain horizon · {percent(sample.solar_fraction)} of the Sun’s disk visible</dd></div>
      </dl>
      <p>Values are for the selected timeline sample. Refined transitions can fall between samples.</p>
    </section>}
    {!synthetic && <HorizonReview timeline={row.site.timeline} onInspect={time => inspectAt(Date.parse(time))} />}
    {power && <div className="guide-fields"><label className="field">Panel area (m²)<input type="number" min=".01" step=".01" value={area ?? power.assumptions.area_m2} onChange={event => setArea(event.target.value)} /></label><label className="field">Efficiency (%)<input type="number" min="1" max="100" value={efficiency ?? power.assumptions.efficiency * 100} onChange={event => setEfficiency(event.target.value)} /></label></div>}
    {plot(watts, "Solar power estimate", "Vertical tracking", "Horizontal", "W", factor === 1 ? ["vertical_w", "horizontal_w"] : undefined)}
    {power && factor != null && <p>Window energy estimate: {metrics[3].format(power.energy_wh * factor)} vertical tracking · {metrics[3].format(power.horizontal_energy_wh * factor)} horizontal.</p>}
    {power?.powered_contact ? <p>For the full battery model, see Powered contact windows. To change the load or battery and recompute, open Compare launch slips.</p> : <>
    <div className="guide-fields"><label className="field">Usable battery capacity (Wh)<input type="number" min="0" value={capacity} onChange={event => setCapacity(event.target.value)} /></label><label className="field">Constant load (W)<input type="number" min="1" value={load} onChange={event => setLoad(event.target.value)} /></label></div>
    <p aria-live="polite">{margin == null ? "Enter usable battery capacity and a positive load." : `Rough reserve check for the longest night: ${margin >= 0 ? "yes" : "no"} · ${hours(Math.abs(margin))} ${margin >= 0 ? "of reserve" : "short"} at this load.`}</p></>}
  </section>;
}

const noPoints: never[] = [];
const boardViews = ["Overview", "Timeline", "Analysis"] as const;
type BoardView = typeof boardViews[number];
const overviewMetrics = [metrics[1], metrics[0], metrics[2], metrics[3]];

function ComparisonValues({ rows, onDetails, onChoose, detail = "plain" }: { rows: Scenario[]; onDetails?: (row: Scenario, index: number) => void; onChoose?: (row: Scenario, index: number) => void; detail?: Detail }) {
  const timeRange = rows[0].request.time_range;
  const commonWindow = rows.every(({ request }) =>
    request.time_range.start_utc === timeRange.start_utc && request.time_range.end_utc === timeRange.end_utc);
  const byContact = [...rows].sort((a, b) => b.site.metrics.longest_communication_hours - a.site.metrics.longest_communication_hours);
  const continuousDifference = commonWindow && byContact.length === 2
    ? byContact[0].site.metrics.longest_communication_hours - byContact[1].site.metrics.longest_communication_hours : 0;
  return <section className="scenario-comparison" aria-label="Compare selected scenarios">
    {commonWindow && <p className="compare-window">{utcRange(timeRange)}</p>}
    {rows.length > 2 && <p className="compare-scroll-hint" data-sites={rows.length}>Scroll the table to see all sites</p>}
    <div className="compare-values-scroll" role="region" aria-label="Comparison values" tabIndex={rows.length > 2 ? 0 : undefined}>
      <table className="comparison-table compare-values" data-sites={rows.length}>
        <thead><tr>
          <th scope="col"><span className="sr-only">Metric</span></th>
          {rows.map((row, index) => <th scope="col" key={row.key}>
            {compareSiteLabel(index)}
            <span className="compare-scenario-name"><strong>{label(row)}</strong><small>{utcRange(row.request.time_range)}</small></span>
            {(onDetails || onChoose) && <span className="compare-column-actions">
              {onDetails && <button type="button" className="text-button" onClick={() => onDetails(row, index)}>More details</button>}
              {onChoose && <button type="button" className="secondary-button" onClick={() => onChoose(row, index)}>Choose this site</button>}
            </span>}
          </th>)}
        </tr></thead>
        <tbody>{overviewMetrics.map(metric => {
          const numbers = rows.map(row => value(row, metric.key)).filter((number): number is number => number != null);
          const best = (metric.higher ? Math.max : Math.min)(...numbers);
          const differs = new Set(numbers.map(metric.format)).size > 1;
          return <tr key={metric.key}>
            <th scope="row">{metric.label}{detail === "engineer" && <small className="compare-metric-key">{metric.key}</small>}</th>
            {rows.map(row => {
              const number = value(row, metric.key);
              const leads = number != null && differs && metric.format(number) === metric.format(best);
              return <td key={row.key} className={leads ? "compare-leading" : undefined}><Metric row={row} metric={metric} exact={detail === "engineer"} /></td>;
            })}
          </tr>;
        })}</tbody>
      </table>
    </div>
    {continuousDifference >= 0.05 && <p className="compare-finding">{compareSiteLabel(rows.indexOf(byContact[0]))} has <strong>{hours(continuousDifference)} more</strong> uninterrupted Earth visibility than {compareSiteLabel(rows.indexOf(byContact[1]))}.</p>}
  </section>;
}

export function ScenarioBoard({ result, audience, onInspect, onSummarySelection, initialRows, selectInitialRows = false, example = false, terrain, initialSelectedIds, hideRankings = false, onDetails, onChoose }: {
  result?: ScenarioResult; audience: Audience; onInspect?: (id: string) => void;
  onSummarySelection?: (sites: Candidate[]) => void; initialRows?: Scenario[]; selectInitialRows?: boolean;
  example?: boolean; terrain?: TerrainData | null;
  /** Site ids picked on the leaderboard, in slot order. */
  initialSelectedIds?: string[];
  hideRankings?: boolean;
  onDetails?: (row: Scenario, label: string) => void;
  onChoose?: (row: Scenario, label: string) => void;
}) {
  const [rows, setRows] = useState<Scenario[]>(() => initialRows ?? result?.candidates.map(site => ({ site, request: result.request, key: scenarioKey(site.id, result.request) })) ?? []);
  const [selected, setSelected] = useState<string[]>(() => initialSelectedIds?.length
    ? initialSelectedIds.flatMap(id => rows.find(row => row.site.id === id)?.key ?? []).slice(0, COMPARE_LIMIT)
    : rows.slice(0, selectInitialRows ? COMPARE_LIMIT : 2).map(row => row.key));
  const [view, setView] = useState<BoardView>("Overview");
  const [detail, setDetailState] = useState<Detail>(readDetail);
  function setDetail(next: Detail) {
    setDetailState(next);
    try { localStorage.setItem("lumen-compare-detail", next); } catch { /* storage is optional */ }
  }
  const [analysisVisited, setAnalysisVisited] = useState(false);
  const boardId = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const shareMenu = useRef<HTMLDetailsElement>(null);
  const shareField = useRef<HTMLInputElement>(null);
  const [sort, setSort] = useState<Key | "start">("start");
  const [sharing, setSharing] = useState(false);
  const [addingSite, setAddingSite] = useState(false);
  const extraSitePicker = useRef<HTMLSelectElement>(null);
  const addSiteButton = useRef<HTMLButtonElement>(null);
  const sitePickers = useRef<(HTMLSelectElement | null)[]>([]);
  const [editing, setEditing] = useState<Scenario | null>(null);
  const [startDate, setStartDate] = useState("");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [map, setMap] = useState(false);
  const [terrainOpen, setTerrainOpen] = useState(false);
  const [terrainView, setTerrainView] = useState<"map" | "terrain">("terrain");
  const [openChart, setOpenChart] = useState<{ key: string; time?: number; revision: number; cutoff?: Cutoff }>();
  const [launch, setLaunch] = useState<{ key: string }>();
  const [poweredMinimumHours, setPoweredMinimumHours] = useState("12");
  const launchKey = launch?.key;
  const launchRow = rows.find(row => row.key === launchKey);
  const chartSection = useRef<HTMLDivElement>(null);
  const launchSection = useRef<HTMLDivElement>(null);
  const chart = openChart?.key;
  useEffect(() => {
    if (openChart) chartSection.current?.focus();
  }, [openChart]);
  useEffect(() => {
    if (launch) launchSection.current?.focus();
  }, [launch]);
  useEffect(() => {
    if (sharing) {
      shareField.current?.focus();
      shareField.current?.select();
    }
  }, [sharing]);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const picked = useMemo(() => selected.flatMap(key => rows.find(row => row.key === key) ?? []), [rows, selected]);
  const summarySites = useMemo(() => result ? picked
    .filter(row => row.key === scenarioKey(row.site.id, result.request))
    .map(row => row.site) : [], [picked, result]);
  useEffect(() => onSummarySelection?.(summarySites), [onSummarySelection, summarySites]);
  const compareFull = picked.length >= COMPARE_LIMIT;
  const canPickMore = picked.length < rows.length && !compareFull;
  const showExtraPicker = addingSite && canPickMore;
  const slots = showExtraPicker ? [...picked, null] : picked;
  const optionNames = useMemo(() => rows.map(row => {
    const name = label(row);
    const position = siteCoordinates(row);
    const sameName = rows.some(other => other !== row && label(other) === name);
    return { key: row.key, name: [name, utcRange(row.request.time_range), name !== position && position].filter(Boolean).join(" · ") };
  }), [rows]);
  useEffect(() => { if (showExtraPicker) extraSitePicker.current?.focus(); }, [showExtraPicker]);
  const compared = new Map(picked.flatMap((row, index) => result && row.key === scenarioKey(row.site.id, result.request)
    ? [[row.site.id, compareSiteLabel(index)] as const] : []));
  const currentLabel = (row: Scenario) => {
    const index = picked.indexOf(row);
    return index < 0 ? label(row) : comparisonLabel(row, index);
  };
  const axis = picked.length ? picked : rows;
  const start = axis.length ? Math.min(...axis.map(row => Date.parse(row.request.time_range.start_utc))) : Date.parse(result?.common_window.start_utc ?? "");
  const end = axis.length ? Math.max(...axis.map(row => Date.parse(row.request.time_range.end_utc))) : Date.parse(result?.common_window.end_utc ?? "");
  const maxOffset = Math.ceil((end - start) / 60_000);
  const clock = Math.min(start + offset * 60_000, end);
  const sorted = [...rows].sort((a, b) => {
    if (sort === "start") return Date.parse(a.request.time_range.start_utc) - Date.parse(b.request.time_range.start_utc);
    const direction = metrics.find(metric => metric.key === sort)?.higher ? -1 : 1;
    const first = value(a, sort), second = value(b, sort);
    if (first == null) return second == null ? 0 : 1;
    if (second == null) return -1;
    return (first - second) * direction;
  });
  const chartRow = rows.find(row => row.key === chart);
  function show(view: BoardView) {
    setView(view);
    if (view === "Analysis") setAnalysisVisited(true);
  }
  function openEvidence(row: Scenario, time?: number, cutoff?: Cutoff) {
    setLaunch(undefined);
    setOpenChart(current => ({ key: row.key, cutoff, time, revision: (current?.revision ?? 0) + 1 }));
    show("Analysis");
  }
  function inspectCutoff(row: Scenario, cutoff: Cutoff) {
    openEvidence(row, Date.parse(cutoff.time_utc), cutoff);
  }
  const mapSites = useMemo(() => [...new Map(picked.map(row => [row.site.id, row.site])).values()], [picked]);
  const sharedTerrain = useLocalTerrain(terrainOpen && terrain && mapSites.every(site => site.latitude_deg <= -86.9) ? siteFrame(mapSites) : null, terrain ?? null);
  const alternatives = [...new Map([...(result?.alternatives ?? []), ...rows.flatMap(row => row.alternatives ?? [])]
    .map(option => [option.suggestion_id ?? `${option.kind}:${option.id}:${JSON.stringify(option.request)}`, option])).values()];
  const activeRowsBySite = new Map<string, Scenario>();
  for (const row of picked) {
    if (clock >= Date.parse(row.request.time_range.start_utc)
      && clock <= Date.parse(row.request.time_range.end_utc) && !activeRowsBySite.has(row.site.id)) {
      activeRowsBySite.set(row.site.id, row);
    }
  }
  const activeSites = Array.from(activeRowsBySite.values(), row => row.site);
  const sceneSample = activeSites[0]?.timeline[Math.max(0, sampleIndexAt(activeSites[0].timeline, clock))];
  function appendSelection(key: string) {
    setSelected(current => current.includes(key) || current.length >= COMPARE_LIMIT ? current : [...current, key]);
    setAddingSite(false);
  }
  function replaceSelection(index: number, key: string) {
    setSelected(current => {
      const previousIndex = current.indexOf(key);
      return current.map((currentKey, position) => position === index ? key
        : position === previousIndex ? current[index] : currentKey);
    });
  }
  function removeSelection(key: string) {
    setSelected(current => current.filter(item => item !== key));
    setAddingSite(false);
  }
  function toggleCandidate(id: string) {
    if (!result) return;
    const key = scenarioKey(id, result.request);
    if (compared.has(id)) removeSelection(key);
    else if (!compareFull) {
      if (rows.some(row => row.key === key)) appendSelection(key);
      else return add(id, result.request, undefined, true);
    }
  }
  async function add(id: string, request: Scenario["request"], name?: string, addToComparison = false) {
    if (controller.current) return "Another site is being analyzed.";
    if (rows.length >= MAX_SCENARIOS) return "Remove a saved scenario in Edit scenarios to make room for another site.";
    setError("");
    if (rows.some(row => row.key === scenarioKey(id, request))) {
      const message = "That site and window are already on the board.";
      if (!addToComparison) setError(message);
      return message;
    }
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    try {
      const row = await loadScenario(id, request, abort.signal, !addToComparison);
      if (abort.signal.aborted) return;
      setRows(current => current.some(item => item.key === row.key) || current.length >= MAX_SCENARIOS ? current : [...current, { ...row, label: name }]);
      if (addToComparison) appendSelection(row.key);
      setEditing(null);
    } catch (reason) {
      if (!abort.signal.aborted) {
        const message = reason instanceof Error ? reason.message : "Site analysis unavailable.";
        if (!addToComparison) setError(message);
        return message;
      }
    } finally {
      controller.current = null;
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  function useAlternative(alternative: Alternative) {
    const base = rows.find(row => row.site.id === alternative.for_site);
    const target = alternativeScenario(alternative, base?.request ?? result?.request);
    if (target) return add(target.id, target.request);
    setError("This suggestion is missing the target site or request needed to analyze it.");
  }
  const shareLink = sharing && picked.length ? new URL(scenarioShareHash(picked), window.location.href).href : "";
  function exportCsv() {
    downloadTimelineCsv(picked.map((row, index) => ({ comparison_slot: compareSiteLabel(index), site_id: row.site.id, start_utc: row.request.time_range.start_utc, end_utc: row.request.time_range.end_utc,
      illumination_fraction: row.site.metrics.illumination_fraction, earth_visibility_fraction: row.site.metrics.earth_visibility_fraction,
      longest_darkness_hours: row.site.metrics.longest_darkness_hours, energy_wh: row.site.power?.energy_wh,
      next_sunset_utc: nextEvent(row.site, "sunset", Math.max(clock, Date.parse(row.request.time_range.start_utc)))?.time_utc,
      next_earthset_utc: nextEvent(row.site, "earthset", Math.max(clock, Date.parse(row.request.time_range.start_utc)))?.time_utc })), "lumen-scenarios.csv");
  }

  const canAdd = !busy && rows.length < MAX_SCENARIOS;
  const ids = (name: BoardView) => ({ tab: `${boardId}-tab-${name}`, panel: `${boardId}-panel-${name}` });
  const synthetic = import.meta.env.VITE_LUMEN_MOCK === "1" || result?.provenance.synthetic === true;
  function closeActions() {
    if (!shareMenu.current) return;
    shareMenu.current.open = false;
    shareMenu.current.querySelector("summary")?.focus();
  }
  return <section className="scenario-board" aria-labelledby="scenario-board-title" onKeyDown={event => {
    if (event.key !== "Escape" || !(event.target instanceof Element)) return;
    const menu = event.target.closest<HTMLDetailsElement>(".compare-actions[open], .compare-row-menu[open]");
    if (!menu) return;
    menu.open = false;
    menu.querySelector("summary")?.focus();
  }}>
    <h2 id="scenario-board-title" className="sr-only">Scenario board</h2>
    {rows.length > 0 && <ol className="compare-steps" aria-label="How to compare">
      <li className={picked.length >= 2 ? "done" : "current"}><strong>Choose 2–4 scenarios</strong><span>Pick a site in each slot below, or tick scenarios under “Edit scenarios”. A scenario is one site with one set of mission dates.</span></li>
      <li className={picked.length >= 2 ? "current" : ""}><strong>Read the comparison</strong><span>The table and charts under Overview update as you choose. Timeline lines the scenarios up on a shared clock; Analysis has mission checks.</span></li>
      <li aria-live="polite" className="compare-count"><strong>{picked.length} of {COMPARE_LIMIT} selected</strong><span>{picked.length < 2 ? `Add ${2 - picked.length} more to compare.` : picked.length < COMPARE_LIMIT ? `You can add ${COMPARE_LIMIT - picked.length} more.` : "Remove one to add another."}</span></li>
    </ol>}
    {rows.length > 0 && <div className="compare-site-controls glass-surface" id="comparison-sites" role="group" aria-label="Sites to compare">
      <div className="compare-site-slots">
        {slots.map((row, index) => <div className="compare-site-slot" key={index}>
          <label className="field">
            <strong>{compareSiteLabel(index)}</strong>
            <select ref={row ? node => { sitePickers.current[index] = node; } : extraSitePicker}
              value={row?.key ?? ""} onChange={event => row
                ? replaceSelection(index, event.target.value) : appendSelection(event.target.value)}>
              {!row && <option value="" disabled>Choose a site</option>}
              {optionNames.filter(option => row || !selected.includes(option.key))
                .map(option => <option key={option.key} value={option.key}>{option.name}</option>)}
            </select>
            {row && <small className="compare-slot-dates">{label(row)} · {utcRange(row.request.time_range)}</small>}
          </label>
          <button type="button" className="compare-remove-site"
            aria-label={`${row ? "Remove" : "Cancel adding"} ${compareSiteLabel(index)}`}
            onClick={() => {
              if (row) {
                (picked.length > 1 ? sitePickers.current[Math.max(0, index - 1)] : tabs.current[0])?.focus();
                removeSelection(row.key);
              } else {
                setAddingSite(false);
                addSiteButton.current?.focus();
              }
            }}><Icon name="close" size={16} /></button>
        </div>)}
      </div>
      {canPickMore && <button type="button" ref={addSiteButton} className="secondary-button compare-add-site"
        aria-expanded={showExtraPicker} onClick={() => {
          if (showExtraPicker) extraSitePicker.current?.focus();
          else setAddingSite(true);
        }}><span aria-hidden="true">+</span> Add a site</button>}
      <p className="sr-only" role="status">{picked.length} of {COMPARE_LIMIT} sites selected.</p>
    </div>}
    <div className="compare-toolbar">
      <div className="compare-tabs" role="tablist" aria-label="Comparison views">
        {boardViews.map((name, index) => <button key={name} type="button" role="tab"
          id={ids(name).tab} aria-controls={ids(name).panel} aria-selected={view === name} tabIndex={view === name ? 0 : -1}
          disabled={!rows.length && name !== "Overview"} ref={node => { tabs.current[index] = node; }}
          onKeyDown={event => {
            if (!rows.length) return;
            let next: number;
            if (event.key === "Home") next = 0;
            else if (event.key === "End") next = boardViews.length - 1;
            else if (event.key === "ArrowRight") next = (index + 1) % boardViews.length;
            else if (event.key === "ArrowLeft") next = (index + boardViews.length - 1) % boardViews.length;
            else return;
            event.preventDefault();
            show(boardViews[next]);
            tabs.current[next]?.focus();
          }}
          onClick={() => show(name)}>{name}</button>)}
      </div>
      {rows.length > 0 && <div className="compare-detail-toggle" role="group" aria-label="Level of detail">
        <button type="button" aria-pressed={detail === "plain"} onClick={() => setDetail("plain")}>Plain view</button>
        <button type="button" aria-pressed={detail === "engineer"} onClick={() => setDetail("engineer")}>Engineer view</button>
      </div>}
      {rows.length > 0 && <details ref={shareMenu} className="compare-actions">
        <summary aria-label="Share and export"><Icon name="download" size={16} /><span className="compare-action-label">Share</span></summary>
        <div className="compare-menu">
          <button disabled={!picked.length} onClick={() => { closeActions(); setSharing(true); }}>Share link</button>
          <button disabled={!picked.length} onClick={() => { closeActions(); exportCsv(); }}>Export CSV</button>
          <button disabled={!picked.length} onClick={() => { closeActions(); window.print(); }}>Print / Save PDF</button>
        </div>
      </details>}
    </div>

    {shareLink && <div className="compare-share">
      <label className="field">Share link<input ref={shareField} readOnly value={shareLink} onFocus={event => event.currentTarget.select()} /></label>
      <button className="text-button" onClick={() => { setSharing(false); shareMenu.current?.querySelector("summary")?.focus(); }}>Done</button>
    </div>}

    <div className="scenario-overview" role="tabpanel" id={ids("Overview").panel} aria-labelledby={ids("Overview").tab} hidden={view !== "Overview"}>
      {picked.length > 1 && detail === "plain" && <KeyDifferences rows={picked} />}
      {picked.length > 0 && <ComparisonValues rows={picked} detail={detail}
        onDetails={onDetails ? (row, index) => onDetails(row, comparisonLabel(row, index)) : undefined}
        onChoose={onChoose ? (row, index) => onChoose(row, comparisonLabel(row, index)) : undefined} />}
      {picked.length > 0 && <PowerUse rows={picked} name={comparisonLabel} start={start} end={end} />}
      {picked.length > 0 && detail === "engineer" && <section className="compare-assumptions" aria-label="Exact values and assumptions">
        <h3>Assumptions behind these values</h3>
        <dl>
          {metrics.map(metric => <div key={metric.key}><dt>{metric.label} <code>{metric.key}</code></dt><dd>{metric.meaning}</dd></div>)}
          <div><dt>Time sampling</dt><dd>Sun and Earth positions every 5 minutes from NASA/NAIF SPICE (DE440, MOON_ME frame); fractions integrate left samples over the mission window. Transitions are uncertain by up to one sample.</dd></div>
          <div><dt>Terrain horizon</dt><dd>NASA LOLA horizon profiles at 5° bearings per site; the larger of two adjacent bins is used. Observer 2 m above the surface.</dd></div>
          <div><dt>Mission windows</dt><dd>{picked.map((row, index) => `${compareSiteLabel(index)}: ${row.request.time_range.start_utc} → ${row.request.time_range.end_utc}`).join(" · ")}</dd></div>
        </dl>
      </section>}
      {picked.length < 2 && canPickMore && <p className="compare-selection-hint">Add {picked.length ? "another site" : "a site"} to start comparing.</p>}
      {rows.length > 0 && <details className="compare-management">
        <summary>Edit scenarios</summary>
        <section className="compare-scenarios" aria-label="Scenarios">
        <header className="compare-section-heading">
          <div><h3>Scenarios</h3><p aria-live="polite">{picked.length} selected · Compare up to {COMPARE_LIMIT}</p></div>
          {rows.length > 2 && <label className="field compare-sort">Sort by<select value={sort} onChange={event => setSort(event.target.value as typeof sort)}>
            <option value="start">Start date</option>{metrics.map(metric => <option key={metric.key} value={metric.key}>{metric.label}</option>)}
          </select></label>}
        </header>
        <ul className="compare-scenario-list">
          {sorted.map(row => {
            const checked = selected.includes(row.key);
            const candidate = result?.candidates.some(site => site.id === row.site.id && row.key === scenarioKey(site.id, result.request));
            return <li key={row.key} data-scenario-start={row.request.time_range.start_utc}>
              <label className="compare-scenario-choice">
                <input type="checkbox" checked={checked} disabled={!checked && selected.length >= COMPARE_LIMIT}
                  aria-label={`Compare ${label(row)} starting ${row.request.time_range.start_utc}`}
                  onChange={() => checked ? removeSelection(row.key) : appendSelection(row.key)} />
                <span><strong>{label(row)}</strong><small>{utcRange(row.request.time_range)}</small>
                  {row.constraint_status?.passes === false && <small className="compare-limit-status">Falls short of mission limits</small>}
                </span>
              </label>
              <details className="compare-row-menu">
                <summary aria-label={`Actions for ${label(row)} starting ${row.request.time_range.start_utc}`}><span aria-hidden="true">•••</span></summary>
                <div className="compare-menu" onClick={event => {
                  if ((event.target as HTMLElement).closest("button")) {
                    const disclosure = event.currentTarget.parentElement as HTMLDetailsElement;
                    disclosure.open = false;
                    disclosure.querySelector("summary")?.focus();
                  }
                }}>
                  {onInspect && row.site.rank > 0 && candidate && <button onClick={() => onInspect(row.site.id)}>Inspect site</button>}
                  <button onClick={() => openEvidence(row)}>Charts and evidence</button>
                  <button onClick={() => { setOpenChart(undefined); setLaunch({ key: row.key }); show("Analysis"); }}>Compare launch slips</button>
                  <button disabled={!canAdd} onClick={() => { setEditing(row); setStartDate(row.request.time_range.start_utc.slice(0, 16)); }}>Duplicate &amp; change date</button>
                  {!candidate && <button onClick={event => {
                    event.stopPropagation();
                    const item = event.currentTarget.closest("li");
                    const neighbor = item?.nextElementSibling ?? item?.previousElementSibling;
                    const nextFocus = neighbor?.querySelector<HTMLInputElement>("input:not(:disabled)") ?? tabs.current[0];
                    nextFocus?.focus();
                    setRows(current => current.filter(item => item.key !== row.key));
                    setSelected(current => current.filter(key => key !== row.key));
                    if (editing?.key === row.key) setEditing(null);
                    if (launchKey === row.key) setLaunch(undefined);
                    if (chart === row.key) setOpenChart(undefined);
                  }}>Remove from board</button>}
                </div>
              </details>
            </li>;
          })}
        </ul>
        {editing && <form className="scenario-tools compare-add" onSubmit={event => { event.preventDefault(); void add(editing.site.id, scenarioWindow(editing.request, `${startDate}Z`), label(editing)); }}>
          <label className="field">New start date for {label(editing)} (UTC)<input autoFocus required type="datetime-local" value={startDate} onChange={event => setStartDate(event.target.value)} /></label>
          <button className="primary-button" disabled={!canAdd}>Analyze the new date</button>
          <button type="button" className="text-button" onClick={() => setEditing(null)}>Cancel</button>
        </form>}
        </section>
      </details>}
    </div>

    <div className="compare-timeline-panel" role="tabpanel" id={ids("Timeline").panel} aria-labelledby={ids("Timeline").tab} hidden={view !== "Timeline"}>
      {view === "Timeline" && !picked.length && <p>Add a site to see its timeline.</p>}
      {view === "Timeline" && picked.length > 0 && <>
        <header className="compare-section-heading"><h3>Sunlight and Earth visibility</h3></header>
        <label className="field scenario-clock glass-surface">Compare time <time dateTime={new Date(clock).toISOString()}>{utcTime(new Date(clock).toISOString())}</time>
          <input type="range" aria-label="Compare time" min={0} max={maxOffset} value={Math.min(offset, maxOffset)} aria-valuetext={utcTime(new Date(clock).toISOString())} onChange={event => setOffset(Number(event.target.value))} />
        </label>
        <p className="compare-clock-help">The shared clock is one moment in time, applied to every selected scenario at once. Drag it to see which sites have the Sun and Earth in view at that instant: filled bars mean visible, gaps mean hidden behind terrain or below the horizon. Scenarios with different dates sit side by side on the same calendar, so a scenario shows nothing while the clock is outside its dates. It does not change any results.</p>
        <Timeline rows={picked} start={start} end={end} clock={clock} onInspect={inspectCutoff} />
        <details className="compare-disclosure">
          <summary>Upcoming cutoffs</summary>
          <p className="field-hint">Countdowns follow the compare clock. Times marked “About” are estimated from samples.</p>
          <div className="compare-values-scroll" role="region" aria-label="Upcoming cutoffs" tabIndex={0}>
            <table className="comparison-table compare-values compare-cutoffs"><thead><tr><th scope="col">Scenario</th><th scope="col">Next sunset</th><th scope="col">Next Earthset</th></tr></thead>
              <tbody>{picked.map((row, index) => <tr key={row.key} data-scenario-start={row.request.time_range.start_utc}>
                <th scope="row">{comparisonLabel(row, index)} <small>{row.request.time_range.start_utc.slice(0, 10)}</small></th>
                {(["sunset", "earthset"] as const).map(type => <td key={type}>
                  <EventCountdown row={row} type={type} clock={Math.max(clock, Date.parse(row.request.time_range.start_utc))} onInspect={cutoff => inspectCutoff(row, cutoff)} />
                </td>)}
              </tr>)}</tbody>
            </table>
          </div>
        </details>
        {terrain && mapSites.length > 0 && <details className="compare-disclosure" open={terrainOpen} onToggle={event => setTerrainOpen(event.currentTarget.open)}>
          <summary>Shared terrain at the compare clock</summary>
          {terrainOpen && <div className="scenario-terrain">
            <label className="field compare-terrain-view">Terrain view
              <select value={terrainView} onChange={event => setTerrainView(event.target.value === "map" ? "map" : "terrain")}>
                <option value="terrain">3D terrain</option>
                <option value="map">2D map</option>
              </select>
            </label>
            {sceneSample ? <Suspense fallback={<p role="status">Loading shared terrain…</p>}><TerrainScene terrain={sharedTerrain ?? terrain} candidates={activeSites}
              selected={activeSites[0].id} onSelect={id => {
                const row = activeRowsBySite.get(id);
                if (row) openEvidence(row, clock);
              }} compare={picked.map(row => row.site.id)} comparisonSites={mapSites} sample={sceneSample} mode={terrainView} layer="terrain"
              mapCandidates={result?.map_candidates ?? noPoints} psr={null} features={[]} /></Suspense>
              : <p>No selected scenario covers this clock time.</p>}
            <div className="scenario-tools">{mapSites.map(site => {
              const slots = picked.flatMap((row, index) => row.site.id === site.id ? [index] : []);
              return <span key={site.id}>
                <span className="scenario-dot" style={{ backgroundColor: COMPARE_COLORS[slots[0]] }} />
                {slots.map(compareSiteLabel).join(" / ")} · {coordinate(site.latitude_deg, site.longitude_deg_east)}
              </span>;
            })}</div>
          </div>}
        </details>}
        {mapSites.length > 1 && <details className="compare-disclosure" open={map} onToggle={event => setMap(event.currentTarget.open)}>
          <summary>Locate selected sites on the Moon</summary>
          {map && <div className="scenario-map"><Suspense fallback={<p role="status">Loading Moon…</p>}><GlobeScene sites={mapSites}
            selectedCenter={mapSites[0]} timeRange={{ start_utc: new Date(start).toISOString(), end_utc: new Date(end).toISOString() }}
            preparedLabel="Selected scenario locations" /></Suspense></div>}
        </details>}
      </>}
    </div>

    <div className="compare-analysis-panel" role="tabpanel" id={ids("Analysis").panel} aria-labelledby={ids("Analysis").tab} hidden={view !== "Analysis"}>
      {analysisVisited && <>
        {chartRow && <div className="scenario-chart-section" tabIndex={-1} ref={chartSection}>
          <header className="compare-section-heading"><h3>{label(chartRow)} · {utcTime(chartRow.request.time_range.start_utc)}</h3>
            <button className="text-button" onClick={() => { setOpenChart(undefined); tabs.current[2]?.focus(); }}>Close evidence</button>
          </header>
          <Charts key={`${chartRow.key}:${openChart?.revision}`} row={chartRow} targetTime={openChart?.time} cutoff={openChart?.cutoff}
            synthetic={synthetic || chartRow.site.id.startsWith("fixture-")} />
        </div>}
        {launchRow && <div className="compare-launch-section" ref={launchSection} tabIndex={-1}>
          <LaunchSlipComparison key={launchRow.key} baseline={launchRow} name={label(launchRow)} board={rows}
            minimum={poweredMinimumHours} onMinimumChange={setPoweredMinimumHours} canAdd={canAdd}
            onAdd={row => setRows(current => current.length >= MAX_SCENARIOS || current.some(item => item.key === row.key) ? current : [...current, row])}
            onClose={() => { setLaunch(undefined); tabs.current[2]?.focus(); }} />
        </div>}
        {picked.length > 0 ? <>
          <details className="compare-disclosure compare-tool" open>
            <summary>Mission windows</summary>
            <MissionWindowCheck rows={picked} board={rows} name={currentLabel} example={example} synthetic={synthetic} onInspect={(row, time) => openEvidence(row, time)} />
          </details>
          <details className="compare-disclosure compare-tool">
            <summary>Powered contact</summary>
            <PoweredContactWindow rows={picked} name={currentLabel} minimumHours={poweredMinimumHours}
              onMinimumChange={setPoweredMinimumHours} clock={clock} />
          </details>
        </> : <p>Add a site to analyze its mission window.</p>}
        {picked.length > 1 && <CopilotExplanation key={JSON.stringify(picked.map(row => row.key))} candidates={picked.map(row => ({
          name: `${currentLabel(row).slice(0, 75)} · ${row.request.time_range.start_utc.slice(0, 16).replace("T", " ")} UTC`,
          sunlight_fraction: row.site.metrics.illumination_fraction,
          earth_visibility_fraction: row.site.metrics.earth_visibility_fraction,
          longest_darkness_hours: row.site.metrics.longest_darkness_hours,
        }))} />}
        <details className="compare-disclosure">
          <summary>Metric definitions</summary>
          <dl className="compare-metric-definitions">{metrics.map(metric => <div key={metric.key}>
            <dt>{metric.label}</dt><dd>{metric.meaning}</dd>
          </div>)}</dl>
        </details>
        {audience === "Educator" && <details className="compare-disclosure">
          <summary>Classroom exercise</summary>
          <ol><li>Predict which site can see Earth for longer.</li><li>Choose Sunlight and Earth in view and set a 72-hour minimum.</li><li>Set geometric margins of 80% of the solar disk and more than 1° of Earth clearance. Did your choice change?</li></ol>
        </details>}
      </>}
    </div>
    {result && onInspect && !hideRankings && <CandidateResults result={result} onSelect={onInspect} onToggleCompare={toggleCandidate}
      compared={compared} comparisonFull={compareFull} />}
    {busy && <p role="status">Analyzing scenario…</p>}
    {error && <p role="alert" className="guide-error">{error}</p>}
    <div hidden={view !== "Analysis" && rows.length > 0 && !rows.some(row => row.constraint_status?.passes === false)}>

    {(result?.candidates.length === 0 || !!alternatives.length || rows.some(row => row.constraint_status?.passes === false)) && <section className="scenario-alternatives"><h3>Try instead</h3>
      {!alternatives.length ? <p>No alternatives were returned for this mission. You can edit the area, dates, or required limits and analyze again.</p> :
        <div className="scenario-alternative-grid">{alternatives.slice(0, 3).map(alternative => {
          const base = rows.find(row => row.site.id === alternative.for_site);
          return <article key={alternative.suggestion_id ?? `${alternative.kind}-${alternative.id}`}><strong>{({ nearby: "Nearby site", shifted_window: "Shift the dates", relaxed: "Adjust a limit" })[alternative.kind]}</strong>
            <p>{alternative.reason}</p>
            {!!alternative.resolves.length && <p>Addresses {alternative.resolves.map(key => key.replaceAll("_", " ")).join(", ")}.</p>}<ul>{metrics.slice(0, 3).map(metric => {
              if (metric.key === "energy_wh") return null;
              const after = alternative.metrics[metric.key], before = alternative.before_metrics?.[metric.key] ?? base?.site.metrics[metric.key];
              return after == null ? null : <li key={metric.key}>{metric.label}: {before == null ? "" : `${metric.format(before)} → `}{metric.format(after)}</li>;
            })}</ul>
            <button className="secondary-button" disabled={busy || rows.length >= MAX_SCENARIOS} onClick={() => void useAlternative(alternative)}>Use this scenario</button></article>;
        })}</div>}
    </section>}
    <details className="scenario-limitations"><summary>What this can’t tell you</summary><p>Earth in view describes geometry. It cannot establish a reliable radio link. Estimated panel output excludes dust, temperature, and degradation. The battery check assumes constant load and a full usable battery before the longest night. Terrain indicators cannot establish landing safety.</p></details>
    </div>
  </section>;
}
