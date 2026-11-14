import { useMemo, useState } from "react";
import { downloadTimelineCsv, hours, utcTime } from "../lib/format";
import { checkWindow, WINDOW_REQUIREMENTS } from "../lib/mission-window";
import type { WindowRequirement } from "../lib/mission-window";
import type { Scenario } from "../lib/scenarios";

export function MissionWindowCheck({ rows, board, name, onInspect, example, synthetic }: {
  rows: Scenario[];
  board: Scenario[];
  name: (row: Scenario) => string;
  onInspect: (row: Scenario, time: number) => void;
  example: boolean;
  synthetic: boolean;
}) {
  const [requirement, setRequirement] = useState<WindowRequirement>("earth");
  const [minimum, setMinimum] = useState(example ? "110" : "24");
  const [useClearance, setUseClearance] = useState(false);
  const [disk, setDisk] = useState("80");
  const [earth, setEarth] = useState("1");
  const limits = useMemo(() => useClearance
    ? { solarDiskPercent: Number(disk), earthDegrees: Number(earth) }
    : undefined, [useClearance, disk, earth]);
  const validClearance = !limits || (
    (requirement === "earth" || (disk !== "" && limits.solarDiskPercent >= 0 && limits.solarDiskPercent <= 100)) &&
    (requirement === "sun" || (earth !== "" && limits.earthDegrees >= 0 && limits.earthDegrees <= 90))
  );
  const minimumHours = Number(minimum);
  const valid = minimum !== "" && Number.isFinite(minimumHours) && minimumHours > 0;
  const boardChecks = useMemo(() => valid && validClearance
    ? board.map(row => ({ row, ...checkWindow(row, requirement, minimumHours, limits) }))
    : [], [board, limits, minimumHours, requirement, valid, validClearance]);
  const selected = new Set(rows.map(row => row.key));
  const checks = boardChecks.filter(check => selected.has(check.row.key));
  const showRecovery = checks.some(check => check.available) && !checks.some(check => check.meets);
  const alternatives = boardChecks.filter(check => !selected.has(check.row.key) && check.meets);
  const anyUnknown = boardChecks.some(check => !check.available);
  function download() {
    downloadTimelineCsv(checks.map(check => ({
      site_id: check.row.site.id,
      scenario_start_utc: check.row.request.time_range.start_utc,
      scenario_end_utc: check.row.request.time_range.end_utc,
      condition: requirement,
      minimum_continuous_hours: minimumHours,
      min_visible_solar_disk_pct: requirement !== "earth" ? limits?.solarDiskPercent : undefined,
      earth_clearance_greater_than_deg: requirement !== "sun" ? limits?.earthDegrees : undefined,
      outcome: !check.available ? "Unavailable" : check.meets ? "Meets requirement" : "Falls short",
      longest_continuous_hours: check.available ? check.longestHours : null,
      margin_hours: check.available ? check.marginHours : null,
      interval_start_utc: check.longest && new Date(check.longest.start).toISOString(),
      interval_end_utc: check.longest && new Date(check.longest.end).toISOString(),
      latitude_deg: check.row.site.latitude_deg,
      longitude_deg_east: check.row.site.longitude_deg_east,
      method: check.method,
      synthetic,
    })), "lumen-mission-window.csv");
  }
  return <section className="mission-window" aria-labelledby="mission-window-title">
    <h3 id="mission-window-title">Mission window check</h3>
    <p>Find a continuous window in the selected scenarios. This uses modeled visibility above the terrain.</p>
    <div className="scenario-tools">
      <label className="field">Required condition<select value={requirement} onChange={event => setRequirement(event.target.value as WindowRequirement)}>
        {Object.entries(WINDOW_REQUIREMENTS).map(([key, title]) => <option key={key} value={key}>{title}</option>)}
      </select></label>
      <label className="field">Minimum continuous hours<input type="number" min="0.1" step="any" value={minimum} onChange={event => setMinimum(event.target.value)} /></label>
      <button className="secondary-button" onClick={download} disabled={!checks.length}>Export window check</button>
    </div>
    <label className="window-clearance-toggle"><input type="checkbox" checked={useClearance} onChange={event => setUseClearance(event.target.checked)} /> Apply geometric margins</label>
    {useClearance && <><div className="scenario-tools">
      {requirement !== "earth" && <label className="field">Minimum visible solar disk (%)<input type="number" min="0" max="100" value={disk} onChange={event => setDisk(event.target.value)} /></label>}
      {requirement !== "sun" && <label className="field">Earth clearance above terrain (°)<input type="number" min="0" max="90" step="any" value={earth} onChange={event => setEarth(event.target.value)} /></label>}
    </div><p className="field-hint">Earth’s center must clear the margin. Solar disk exposure is geometric. These windows use the available timeline samples.</p></>}
    {!validClearance && <p role="status">Enter a solar disk percentage from 0–100 and an Earth margin from 0–90° for the fields in use.</p>}
    {!valid && <p role="status">Enter a duration greater than zero.</p>}
    {checks.length > 0 && <div className="mission-window-grid" aria-live="polite">{checks.map(check => <article key={check.row.key}>
      <h4>{name(check.row)} · {check.row.request.time_range.start_utc.slice(0, 10)}</h4>
      {check.available ? <>
        <strong className={check.meets ? "window-met" : "window-missed"}>{check.meets ? "Meets requirement" : "Falls short"}</strong>
        <p>{hours(check.longestHours)} available · {hours(Math.abs(check.marginHours))} {check.meets ? "over minimum" : "short"}</p>
        {check.longest ? <><p>{utcTime(new Date(check.longest.start).toISOString())} → {utcTime(new Date(check.longest.end).toISOString())}</p>
          <button className="text-button" type="button" onClick={() => onInspect(check.row, check.longest!.end)}>Inspect window end</button></> : <p>No continuous window in these dates.</p>}
        <small>{check.method}</small>
      </> : <p>Timeline unavailable.</p>}
    </article>)}</div>}
    {showRecovery && <section className="window-recovery" aria-labelledby="window-recovery-title">
      <h4 id="window-recovery-title">Other analyzed scenarios</h4>
      <div aria-live="polite">
        {alternatives.length ? <ul>{alternatives.map(({ row, longest, longestHours }) => longest && <li key={row.key}>
          <strong>{name(row)} · {row.request.time_range.start_utc.slice(0, 10)}</strong>
          <p>{hours(longestHours)} meets the same requirement.</p>
          <p>{utcTime(new Date(longest.start).toISOString())} → {utcTime(new Date(longest.end).toISOString())}</p>
          <button className="text-button" type="button" onClick={() => onInspect(row, longest.end)}>Inspect qualifying window</button>
        </li>)}</ul> : <p>{anyUnknown ? "No scenario with an available timeline meets this requirement." : "No scenario on the board meets this requirement."} Try duplicating a row to analyze another date.</p>}
      </div>
    </section>}
  </section>;
}
