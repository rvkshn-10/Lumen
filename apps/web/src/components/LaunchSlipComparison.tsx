import { useEffect, useId, useRef, useState } from "react";
import { hours, utcTime } from "../lib/format";
import { getPoweredContact } from "../lib/powered-contact";
import { HOUR_MS, loadScenario, scenarioKey, scenarioWindow } from "../lib/scenarios";
import type { Scenario } from "../lib/scenarios";

const OFFSETS = [0, 24, 72];
const SETTINGS = [
  { key: "load", label: "Payload load (W)", min: 0, max: 1e7 },
  { key: "capacity", label: "Usable battery (Wh)", min: 0, max: 1e9, positive: true },
  { key: "charge", label: "Starting battery charge (%)", min: 0, max: 100 },
  { key: "clearance", label: "Minimum Earth clearance (°)", min: 0, max: 90 },
] as const;
type Slice = { offset: number; request: Scenario["request"]; row?: Scenario; error?: string };

export function LaunchSlipComparison({ baseline, name, board, onAdd, onClose, canAdd, minimum, onMinimumChange }: {
  baseline: Scenario;
  name: string;
  board: Scenario[];
  onAdd: (row: Scenario) => void;
  onClose: () => void;
  canAdd: boolean;
  minimum: string;
  onMinimumChange: (value: string) => void;
}) {
  const title = useId();
  const [settings, setSettings] = useState({
    load: String(baseline.request.power?.load_w ?? 150),
    capacity: String(baseline.request.power?.capacity_wh ?? 2000),
    charge: String((baseline.request.power?.start_soc ?? 1) * 100),
    clearance: String(baseline.request.dte_margin_deg ?? 2),
  });
  const validSettings = SETTINGS.every(field => {
    const input = settings[field.key];
    const n = Number(input);
    return input.trim() !== "" && n >= field.min && n <= field.max && (!("positive" in field) || n > 0);
  });
  const [results, setResults] = useState<Slice[]>([]);
  const [running, setRunning] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    heading.current?.focus();
    return () => {
      controller.current?.abort();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  async function analyze() {
    if (controller.current || !validSettings || !validMinimum) return;
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    setResults([]);
    const applied: Scenario["request"] = {
      ...baseline.request,
      power: { ...baseline.request.power, load_w: Number(settings.load),
        capacity_wh: Number(settings.capacity), start_soc: Number(settings.charge) / 100 },
      dte_margin_deg: Number(settings.clearance),
    };
    try {
      for (const offset of OFFSETS) {
        const start = Date.parse(baseline.request.time_range.start_utc) + offset * HOUR_MS;
        const request = offset === 0
          ? applied
          : scenarioWindow(applied, new Date(start).toISOString());
        let slice: Slice;
        try {
          const row = offset === 0 && baseline.site.constraintStatus && getPoweredContact(baseline) && scenarioKey(baseline.site.id, request) === baseline.key
            ? baseline
            : await loadScenario(baseline.site.id, request, abort.signal, false);
          slice = { offset, request, row: { ...row, label: name } };
        } catch (reason) {
          slice = { offset, request, error: reason instanceof Error ? reason.message : "Analysis unavailable." };
        }
        if (abort.signal.aborted) return;
        setResults(current => [...current, slice]);
      }
    } finally {
      controller.current = null;
      if (!abort.signal.aborted) setRunning(false);
    }
  }

  const minimumHours = Number(minimum);
  const validMinimum = minimum.trim() !== "" && Number.isFinite(minimumHours) && minimumHours > 0;
  return <section className="mission-window launch-slip" aria-labelledby={title}>
    <div className="section-heading">
      <h3 id={title} ref={heading} tabIndex={-1}>Launch-slip comparison · {name}</h3>
      <button className="secondary-button" type="button" onClick={onClose}>Close launch-slip comparison</button>
    </div>
    <p>Compare surface operations starting on the original date, 24 hours later, and 72 hours later. The site, mission duration and assumptions stay fixed.</p>
    <div className="scenario-tools">
      <label className="field">Required continuous powered contact (hours)
        <input type="number" min="0.1" step="any" value={minimum} onChange={event => onMinimumChange(event.target.value)} />
      </label>
      <button className="primary-button" type="button" onClick={() => void analyze()} disabled={running || !validMinimum || !validSettings}>Analyze launch slips</button>
    </div>
    <details className="launch-slip-assumptions">
      <summary>Power and Earth-clearance assumptions</summary>
      <p>All three dates use a {baseline.request.power?.area_m2 ?? 1} m² tracking panel at {(baseline.request.power?.efficiency ?? .3) * 100}% efficiency.</p>
      <div className="scenario-tools">{SETTINGS.map(field => <label key={field.key} className="field">{field.label}
        <input type="number" min={field.min} max={field.max} step="any" disabled={running}
          value={settings[field.key]} onChange={event => {
            setSettings(current => ({ ...current, [field.key]: event.target.value }));
            setResults([]);
          }} />
      </label>)}</div>
    </details>
    {!validSettings && <p role="status">Use a positive battery capacity and keep the other assumptions within their input ranges.</p>}
    {!validMinimum && <p role="status">Enter an operation duration greater than zero.</p>}
    {running && <p role="status">Analyzing date options · {results.length} of {OFFSETS.length} checked</p>}
    <LaunchSlipResults results={results} finished={!running && results.length === OFFSETS.length} minimumHours={validMinimum ? minimumHours : undefined} canAdd={canAdd} board={board} onAdd={onAdd} />
  </section>;
}

function LaunchSlipResults({ results, minimumHours, board, canAdd, onAdd, finished }: {
  results: Slice[];
  minimumHours?: number;
  board: Scenario[];
  canAdd: boolean;
  onAdd: (row: Scenario) => void;
  finished: boolean;
}) {
  if (!results.length) return null;
  const dates = results.map(slice => {
    const row = slice.row;
    const powered = row && getPoweredContact(row);
    const status = row?.site.constraintStatus;
    let reason = slice.error ?? "Powered contact estimate unavailable.";
    if (powered && minimumHours === undefined) reason = "Enter a valid operation duration.";
    else if (status?.passes === false) {
      const failed = [!status.region_pass && "study area", !status.terrain_pass && "terrain", !status.temporal_pass && "mission-time"].filter(Boolean);
      reason = failed.length ? `Falls short on ${failed.join(", ")} requirements.` : "Falls short on the applied mission requirements.";
    } else if (powered && minimumHours !== undefined) {
      if (powered.longest_contact_hours >= minimumHours) reason = "Meets the powered contact requirement.";
      else if (row?.site.dte && row.site.dte.longest_contact_hours < minimumHours) reason = "Too little continuous Earth clearance.";
      else if (powered.first_depletion_utc) reason = `Battery depletion at ${utcTime(powered.first_depletion_utc)} limits this window.`;
      else reason = "The powered contact interval is too short.";
    }
    const meets = minimumHours !== undefined && powered != null && status?.passes !== false &&
      powered.longest_contact_hours >= minimumHours;
    const longest = powered?.windows.reduce<(typeof powered.windows)[number] | undefined>((best, window) =>
      !best || window.duration_hours > best.duration_hours ? window : best, undefined);
    return { ...slice, powered, reason, meets, longest };
  });
  const earliest = dates.find(date => date.meets);
  const incomplete = dates.some(date => !date.powered && date.row?.site.constraintStatus?.passes !== false);
  return <>
    {finished && minimumHours !== undefined && <p role="status">
      {earliest ? `Earliest qualifying date of the tested options: ${utcTime(earliest.request.time_range.start_utc)}.`
        : incomplete ? "No available estimate qualifies. Some dates could not be evaluated."
          : "None of the tested dates meets the requirements."}
    </p>}
    <div className="mission-window-grid">{dates.map(date => <article key={date.offset}>
      <h4>{date.offset ? `+${date.offset} hours` : "Original date"}</h4>
      <p>{utcTime(date.request.time_range.start_utc)} → {utcTime(date.request.time_range.end_utc)}</p>
      <strong className={date.meets ? "window-met" : undefined}>{date.reason}</strong>
      {date.powered && <p>Longest powered contact · {hours(date.powered.longest_contact_hours)}</p>}
      {date.longest && <p>{utcTime(date.longest.start_utc)} → {utcTime(date.longest.end_utc)}</p>}
      {date.row && (board.some(row => row.key === date.row?.key) ? <small>On the scenario board</small>
        : <button className="text-button" type="button" disabled={!canAdd} onClick={() => onAdd(date.row!)}>Add this date to the board</button>)}
    </article>)}</div>
  </>;
}
