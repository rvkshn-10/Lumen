import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { coordinate, downloadTimelineCsv, hours, percent, utcTime } from "../lib/format";
import { scenarioVerdict } from "../lib/explanations";
import { COMPARE_LIMIT, MAX_SCENARIOS, SITE_COLORS, alternativeScenario, batteryMargin, loadScenario, nextEvent, sampledEvents, scenarioKey, scenarioShareHash, scenarioWindow, visibilityRuns } from "../lib/scenarios";
import type { Candidate, TerrainData } from "../lib/types";
import { COMPARE_COLORS, sampleIndexAt } from "../lib/sky-geometry";
import type { Alternative, Audience, Scenario, ScenarioResult } from "../lib/scenarios";
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
const metricAttributes = (id: string, key: string, raw: number | string) => ({ "data-metric": `${id}:${key}`, "data-raw": raw });
const value = (row: Scenario, key: Key) => key === "energy_wh" ? row.site.power?.energy_wh : row.site.metrics[key];
const label = (row: Scenario) => row.label ?? (row.site.rank ? `Candidate ${row.site.rank}` : coordinate(row.site.latitude_deg, row.site.longitude_deg_east));

function Metric({ row, metric }: { row: Scenario; metric: typeof metrics[number] }) {
  const number = value(row, metric.key);
  return number == null ? <span>Unavailable</span> : <span {...metricAttributes(row.site.id, metric.key, number)}>{metric.format(number)}</span>;
}

function EventCountdown({ row, type, clock }: { row: Scenario; type: "sunset" | "earthset"; clock: number }) {
  const end = Date.parse(row.request.time_range.end_utc);
  const events = useMemo(() => row.site.events ?? sampledEvents(row.site.timeline), [row.site]);
  if (clock >= end) return <span>Window ended</span>;
  const event = nextEvent({ ...row.site, events }, type, clock);
  if (!row.site.events && !row.site.timeline.length) return <span>Unavailable</span>;
  if (!event || Date.parse(event.time_utc) >= end) return <span>None remaining</span>;
  const time = Date.parse(event.time_utc);
  const minutes = Math.max(0, Math.ceil((time - clock) / 60_000));
  const days = Math.floor(minutes / 1440), remaining = minutes % 1440;
  return <span data-metric={row.site.events ? `${row.site.id}:${type}` : undefined} data-raw={row.site.events ? event.time_utc : undefined} title={`±${event.uncertainty_minutes} min`}>
    {row.site.events ? "" : "About "}{utcTime(event.time_utc)}<small>{minutes === 0 ? "At selected time" : `In ${days ? `${days} d ` : ""}${Math.floor(remaining / 60)} h ${remaining % 60} min`}</small>
  </span>;
}

function Timeline({ rows, start, end, clock }: { rows: Scenario[]; start: number; end: number; clock: number }) {
  const position = (time: number) => (time - start) * 100 / (end - start);
  const ids = [...new Set(rows.map(row => row.site.id))];
  return <section className="scenario-timeline" aria-label="Aligned site timelines">
    <p>{utcTime(new Date(start).toISOString())} to {utcTime(new Date(end).toISOString())} · Filled segments show visibility</p>
    {rows.map(row => <div className="scenario-strip-row" key={row.key}>
      <strong><span className="scenario-dot" style={{ backgroundColor: SITE_COLORS[ids.indexOf(row.site.id)] }} />{label(row)} · {row.request.time_range.start_utc.slice(0, 10)}</strong>
      {(["sun_visible", "earth_visible"] as const).map((key, index) => {
        const runs = visibilityRuns(row.site, row.request, key);
        const title = index ? "Earth in view" : "Sunlight";
        return <div key={key} className="scenario-strip-line"><span>{title}</span><div className="scenario-strip" aria-hidden="true">
          {runs.map(run => <span className={run.visible ? "visible" : "blocked"} key={run.start} style={{ left: `${position(run.start)}%`, width: `${position(run.end) - position(run.start)}%` }} />)}
          {(row.site.events ?? sampledEvents(row.site.timeline)).filter(event => event.type === (index ? "earthset" : "sunset")).map(event => <span className="scenario-event" key={event.time_utc} style={{ left: `${position(Date.parse(event.time_utc))}%` }} title={utcTime(event.time_utc)} />)}
          <span className="scenario-clock-mark" style={{ left: `${position(clock)}%` }} />
        </div><span className="sr-only">{runs.filter(run => run.visible).map(run => `${utcTime(new Date(run.start).toISOString())} to ${utcTime(new Date(run.end).toISOString())}`).join("; ") || "No visible samples"}</span></div>;
      })}
    </div>)}
  </section>;
}

function Charts({ row }: { row: Scenario }) {
  const [capacity, setCapacity] = useState("2000"), [load, setLoad] = useState("150");
  const [area, setArea] = useState<string>(), [efficiency, setEfficiency] = useState<string>();
  const start = Date.parse(row.request.time_range.start_utc), end = Date.parse(row.request.time_range.end_utc);
  const power = row.site.power;
  const panelArea = area == null ? power?.assumptions.area_m2 ?? 0 : Number(area);
  const panelEfficiency = efficiency == null ? (power?.assumptions.efficiency ?? 0) * 100 : Number(efficiency);
  const factor = power && panelArea > 0 && panelEfficiency > 0 && panelEfficiency <= 100 && power.assumptions.area_m2 > 0 && power.assumptions.efficiency > 0
    ? panelArea * panelEfficiency / (100 * power.assumptions.area_m2 * power.assumptions.efficiency) : undefined;
  const margin = Number(capacity) >= 0 && capacity !== "" && Number(load) > 0 ? batteryMargin(Number(capacity), Number(load), row.site.metrics.longest_darkness_hours) : null;
  const elevations = row.site.timeline.map(sample => ({ time_utc: sample.time_utc, first: sample.sun_elevation_deg, second: sample.sun_horizon_deg }));
  const watts = factor == null ? [] : power?.series.map(sample => ({ time_utc: sample.time_utc, first: sample.vertical_w * factor, second: sample.horizontal_w * factor })) ?? [];
  function plot(points: typeof elevations, title: string, first: string, second: string, unit: string) {
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
      </svg></div>
      <div className="scenario-chart-axis"><span>{utcTime(row.request.time_range.start_utc)}</span><span>{utcTime(row.request.time_range.end_utc)}</span></div>
      <details><summary>Chart data table</summary><div className="table-scroll"><table className="comparison-table"><thead><tr><th scope="col">Time (UTC)</th><th scope="col">{first} ({unit})</th><th scope="col">{second} ({unit})</th></tr></thead>
        <tbody>{points.map(point => <tr key={point.time_utc} data-time-utc={point.time_utc}><th scope="row">{utcTime(point.time_utc)}</th><td {...(unit === "°" ? metricAttributes(row.site.id, "sun_elevation_deg", point.first) : factor === 1 ? metricAttributes(row.site.id, "vertical_w", point.first) : {})}>{point.first.toFixed(2)}</td>
        <td {...(unit === "°" ? metricAttributes(row.site.id, "sun_horizon_deg", point.second) : factor === 1 ? metricAttributes(row.site.id, "horizontal_w", point.second) : {})}>{point.second.toFixed(2)}</td></tr>)}</tbody></table></div></details>
    </figure>;
  }
  return <section className="scenario-charts" aria-label={`${label(row)} charts`}>
    {plot(elevations, "Solar elevation", "Sun elevation", "Terrain horizon", "°")}
    {power && <div className="guide-fields"><label className="field">Panel area (m²)<input type="number" min=".01" step=".01" value={area ?? power.assumptions.area_m2} onChange={event => setArea(event.target.value)} /></label><label className="field">Efficiency (%)<input type="number" min="1" max="100" value={efficiency ?? power.assumptions.efficiency * 100} onChange={event => setEfficiency(event.target.value)} /></label></div>}
    {plot(watts, "Solar power estimate", "Vertical tracking", "Horizontal", "W")}
    {power && factor != null && <p>Window energy estimate: {metrics[3].format(power.energy_wh * factor)} vertical tracking · {metrics[3].format(power.horizontal_energy_wh * factor)} horizontal.</p>}
    <div className="guide-fields"><label className="field">Usable battery capacity (Wh)<input type="number" min="0" value={capacity} onChange={event => setCapacity(event.target.value)} /></label><label className="field">Constant load (W)<input type="number" min="1" value={load} onChange={event => setLoad(event.target.value)} /></label></div>
    <p aria-live="polite">{margin == null ? "Enter usable battery capacity and a positive load." : `Survives the longest night: ${margin >= 0 ? "yes" : "no"} · ${hours(Math.abs(margin))} ${margin >= 0 ? "of reserve" : "short"} at this load.`}</p>
  </section>;
}

export function ScenarioBoard({ result, audience, onInspect, onSummarySelection, initialRows, terrain }: {
  result?: ScenarioResult; audience: Audience; onInspect?: (id: string) => void;
  onSummarySelection?: (sites: Candidate[]) => void; initialRows?: Scenario[]; terrain?: TerrainData | null;
}) {
  const [rows, setRows] = useState<Scenario[]>(() => initialRows ?? result?.candidates.slice(0, 4).map(site => ({ site, request: result.request, key: scenarioKey(site.id, result.request) })) ?? []);
  const [selected, setSelected] = useState<string[]>([]);
  const [sort, setSort] = useState<Key | "start">("start");
  const [sharing, setSharing] = useState(false);
  const [addSite, setAddSite] = useState("");
  const [editing, setEditing] = useState<Scenario | null>(null);
  const [startDate, setStartDate] = useState("");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [map, setMap] = useState(false);
  const [chart, setChart] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const picked = selected.flatMap(key => rows.find(row => row.key === key) ?? []);
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
  const mapSites = [...new Map(picked.map(row => [row.site.id, row.site])).values()];
  const alternatives = [...new Map([...(result?.alternatives ?? []), ...rows.flatMap(row => row.alternatives ?? [])]
    .map(option => [option.suggestion_id ?? `${option.kind}:${option.id}:${JSON.stringify(option.request)}`, option])).values()];
  const activeSites = [...new Map(picked.filter(row => clock >= Date.parse(row.request.time_range.start_utc)
    && clock <= Date.parse(row.request.time_range.end_utc)).map(row => [row.site.id, row.site])).values()];
  const sceneSample = activeSites[0]?.timeline[sampleIndexAt(activeSites[0].timeline, new Date(clock).toISOString())];
  function selectRows(keys: string[]) {
    setSelected(keys);
    onSummarySelection?.(rows.filter(row => keys.includes(row.key) && result &&
      result.candidates.some(site => row.key === scenarioKey(site.id, result.request))).map(row => row.site));
  }
  async function add(id: string, request: Scenario["request"], name?: string) {
    if (controller.current || rows.length >= MAX_SCENARIOS) return;
    setError("");
    if (rows.some(row => row.key === scenarioKey(id, request))) { setError("That site and window are already on the board."); return; }
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    try {
      const row = await loadScenario(id, request, abort.signal);
      if (abort.signal.aborted) return;
      setRows(current => current.some(item => item.key === row.key) ? current : [...current, { ...row, label: name }]);
      setEditing(null);
    } catch (reason) {
      if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "Scenario analysis unavailable.");
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
  const shareLink = sharing && rows.length ? new URL(scenarioShareHash(rows), window.location.href).href : "";
  function exportCsv() {
    downloadTimelineCsv(rows.map(row => ({ site_id: row.site.id, start_utc: row.request.time_range.start_utc, end_utc: row.request.time_range.end_utc,
      illumination_fraction: row.site.metrics.illumination_fraction, earth_visibility_fraction: row.site.metrics.earth_visibility_fraction,
      longest_darkness_hours: row.site.metrics.longest_darkness_hours, energy_wh: row.site.power?.energy_wh,
      next_sunset_utc: nextEvent(row.site, "sunset", Math.max(clock, Date.parse(row.request.time_range.start_utc)))?.time_utc,
      next_earthset_utc: nextEvent(row.site, "earthset", Math.max(clock, Date.parse(row.request.time_range.start_utc)))?.time_utc })), "lumen-scenarios.csv");
  }
  return <section className="scenario-board" aria-labelledby="scenario-board-title">
    <div className="section-heading"><div><h2 id="scenario-board-title">Scenario board</h2><p>Compare up to four site and date combinations at a time.</p></div>
      {!!rows.length && <div className="scenario-tools"><button className="secondary-button" aria-expanded={sharing} onClick={() => setSharing(current => !current)}>Share board</button><button className="secondary-button" onClick={exportCsv}>Export CSV</button><button className="secondary-button" onClick={() => window.print()}>Print / Save PDF</button></div>}</div>
    {shareLink && <label className="field">Share link<input readOnly value={shareLink} onFocus={event => event.currentTarget.select()} /></label>}
    {result && result.candidates.some(site => !rows.some(row => row.key === scenarioKey(site.id, result.request))) && <form className="scenario-tools" onSubmit={event => {
      event.preventDefault();
      const site = result.candidates.find(candidate => candidate.id === addSite);
      if (!site || rows.length >= MAX_SCENARIOS || busy || rows.some(row => row.key === scenarioKey(site.id, result.request))) return;
      setRows(current => [...current, { key: scenarioKey(site.id, result.request), site, request: result.request }]);
      setAddSite("");
    }}>
      <label className="field">Add candidate<select required value={addSite} onChange={event => setAddSite(event.target.value)}>
        <option value="">Choose a candidate</option>{result.candidates.filter(site => !rows.some(row => row.key === scenarioKey(site.id, result.request))).map(site => <option value={site.id} key={site.id}>Candidate {site.rank}</option>)}
      </select></label><button className="secondary-button" disabled={!addSite || busy || rows.length >= MAX_SCENARIOS}>Add to board</button>
    </form>}
    {rows.length > 0 && <>
      <div className="scenario-tools"><label className="field">Sort by<select value={sort} onChange={event => setSort(event.target.value as typeof sort)}><option value="start">Start date</option>{metrics.map(metric => <option key={metric.key} value={metric.key}>{metric.label}</option>)}</select></label>
        <label className="field scenario-clock">Compare time · {utcTime(new Date(clock).toISOString())}<input type="range" min={0} max={maxOffset} value={Math.min(offset, maxOffset)} aria-valuetext={utcTime(new Date(clock).toISOString())} onChange={event => setOffset(Number(event.target.value))} /></label></div>
      <p className="field-hint">Countdowns use the compare clock. Times marked “About” are midpoints between available samples.</p>
      <div className="table-scroll" role="region" aria-label="Scenario rows" tabIndex={0}><table className="comparison-table scenario-table" role="table"><thead role="rowgroup"><tr role="row">
        {[
          ["Compare", ""], ["Site and dates", ""], ["Next sunset", "The next time the Sun drops behind terrain after the compare clock."],
          ["Next Earthset", "The next time Earth's center drops behind terrain after the compare clock."],
          ...metrics.map(metric => [metric.label, metric.meaning]), ["Actions", ""],
        ].map(([col, meaning]) => <th key={col} scope="col" role="columnheader">{col}{meaning && <details><summary aria-label={`Explain ${col}`}>ⓘ</summary>{meaning}</details>}</th>)}
      </tr></thead><tbody role="rowgroup">{sorted.map(row => {
        const checked = selected.includes(row.key);
        return <tr key={row.key} data-scenario-start={row.request.time_range.start_utc} role="row"><td role="cell"><input type="checkbox" checked={checked} disabled={!checked && selected.length >= COMPARE_LIMIT} aria-label={`Compare ${label(row)} starting ${row.request.time_range.start_utc}`} onChange={() => selectRows(checked ? selected.filter(key => key !== row.key) : [...selected, row.key])} /></td>
          <th scope="row" role="rowheader">{label(row)}<small>{utcTime(row.request.time_range.start_utc)} → {utcTime(row.request.time_range.end_utc)}</small>{row.constraint_status?.passes === false && <small className="guide-error">Fails mission limits · see Try instead</small>}</th>
          <td role="cell" data-label="Next sunset"><EventCountdown row={row} type="sunset" clock={Math.max(clock, Date.parse(row.request.time_range.start_utc))} /></td><td role="cell" data-label="Next Earthset"><EventCountdown row={row} type="earthset" clock={Math.max(clock, Date.parse(row.request.time_range.start_utc))} /></td>
          {metrics.map(metric => <td role="cell" key={metric.key} data-label={metric.label}><Metric row={row} metric={metric} /></td>)}
          <td role="cell"><div className="scenario-row-actions"><button className="text-button" aria-pressed={chart === row.key} onClick={() => setChart(current => current === row.key ? "" : row.key)}>Charts</button>
            {onInspect && row.site.rank > 0 && result?.candidates.some(site => site.id === row.site.id && row.key === scenarioKey(site.id, result.request)) && <button className="text-button" onClick={() => onInspect(row.site.id)}>Inspect</button>}
            <button className="text-button" disabled={busy || rows.length >= MAX_SCENARIOS} onClick={() => { setEditing(row); setStartDate(row.request.time_range.start_utc.slice(0, 16)); }}>Duplicate &amp; change date</button>
            <button className="text-button" onClick={() => { setRows(current => current.filter(item => item.key !== row.key)); selectRows(selected.filter(key => key !== row.key)); }}>Remove</button></div></td></tr>;
      })}</tbody></table></div>
      {audience === "Educator" && <p>Try duplicating a site and moving its start date. What changes in the sunlight and Earth-view strips?</p>}
      {audience !== "Planner" && <ul className="scenario-verdicts">{(picked.length ? picked : rows.slice(0, 3)).map(row => <li key={row.key}><strong>{label(row)}.</strong> {scenarioVerdict(row.site.metrics)}</li>)}</ul>}
    </>}
    {editing && <form className="scenario-tools" onSubmit={event => { event.preventDefault(); void add(editing.site.id, scenarioWindow(editing.request, `${startDate}Z`), label(editing)); }}>
      <label className="field">New start date for {label(editing)} (UTC)<input required type="datetime-local" value={startDate} onChange={event => setStartDate(event.target.value)} /></label>
      <button className="primary-button" disabled={busy || rows.length >= MAX_SCENARIOS}>Analyze the new date</button><button type="button" className="secondary-button" onClick={() => setEditing(null)}>Cancel</button>
    </form>}
    {busy && <p role="status">Analyzing scenario…</p>}{error && <p role="alert" className="guide-error">{error}</p>}
    {picked.length > 1 && <section className="scenario-comparison" aria-label="Compare selected scenarios">
      <h3>Compare selected scenarios</h3>
      <Timeline rows={picked} start={start} end={end} clock={clock} />
      {terrain && <div className="scenario-terrain"><h4>Shared terrain at the compare clock</h4>
        <p>{utcTime(new Date(clock).toISOString())} · Only scenarios covering this time are shown. Pin colours match the comparison.</p>
        {sceneSample ? <Suspense fallback={<p role="status">Loading shared terrain…</p>}><TerrainScene
          terrain={terrain} candidates={activeSites} selected={activeSites[0].id} onSelect={id => setChart(picked.find(row => row.site.id === id)?.key ?? "")}
          compare={mapSites.map(site => site.id)} sample={sceneSample} mode="terrain" layer="terrain"
          mapCandidates={result?.map_candidates ?? []} psr={null} features={[]} /></Suspense>
          : <p>No selected scenario covers this clock time.</p>}
        <div className="scenario-tools">{mapSites.map((site, index) => <span key={site.id}><span className="scenario-dot" style={{ backgroundColor: COMPARE_COLORS[index] }} />{coordinate(site.latitude_deg, site.longitude_deg_east)}</span>)}</div>
      </div>}
      <div className="table-scroll" role="region" aria-label="Comparison values" tabIndex={0}><table className="comparison-table"><thead><tr><th scope="col">Indicator</th>{picked.map(row => <th scope="col" key={row.key}><span className="scenario-dot" style={{ backgroundColor: SITE_COLORS[mapSites.findIndex(site => site.id === row.site.id)] }} />{label(row)}<small>{row.request.time_range.start_utc.slice(0, 10)}</small></th>)}</tr></thead>
        <tbody>{metrics.map(metric => {
          const values = picked.flatMap(row => value(row, metric.key) ?? []);
          const best = (metric.higher ? Math.max : Math.min)(...values);
          return <tr key={metric.key}><th scope="row">{metric.label}<details><summary aria-label={`Explain ${metric.label}`}>ⓘ</summary>{metric.meaning}</details></th>
            {picked.map(row => <td key={row.key}><Metric row={row} metric={metric} />{values.length > 1 && value(row, metric.key) != null && (value(row, metric.key) === best
              ? <small className="scenario-best">Best in comparison</small>
              : <small>{metric.key.endsWith("_fraction") ? `${(Math.abs(best - value(row, metric.key)!) * 100).toFixed(1)} percentage points` : metric.format(Math.abs(best - value(row, metric.key)!))} from best</small>)}</td>)}</tr>;
        })}</tbody></table></div>
      {mapSites.length > 1 && <button className="secondary-button" aria-expanded={map} onClick={() => setMap(current => !current)}>{map ? "Hide selected locations" : "Locate selected sites on the Moon"}</button>}
      {map && mapSites.length > 1 && <div className="scenario-map"><Suspense fallback={<p role="status">Loading Moon…</p>}><GlobeScene sites={mapSites} selectedCenter={mapSites[0]} timeRange={{ start_utc: new Date(start).toISOString(), end_utc: new Date(end).toISOString() }} preparedLabel="Selected scenario locations" /></Suspense></div>}
    </section>}
    {chartRow && <div className="scenario-chart-section"><h3>{label(chartRow)} · {utcTime(chartRow.request.time_range.start_utc)}</h3><Charts key={chartRow.key} row={chartRow} /></div>}
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
  </section>;
}
