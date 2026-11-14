import { hours, utcTime } from "../lib/format";
import { getPoweredContact, longestPoweredWindow, meetsPoweredContact, poweredContactAt } from "../lib/powered-contact";
import type { Scenario } from "../lib/scenarios";
import type { PoweredContactResult } from "../lib/types";
import "./powered-contact.css";

function ModelTimeline({ row, result, axis, clock }: {
  row: Scenario;
  result: PoweredContactResult;
  axis: { start: number; end: number };
  clock: number;
}) {
  const x = (value: string) => ((Date.parse(value) - axis.start) / (axis.end - axis.start)) * 100;
  const timeX = ((clock - axis.start) / (axis.end - axis.start)) * 100;
  const power = row.site.power!;
  const capacity = power.battery?.capacity_wh ?? 1;
  const reserve = result.reserve_series.map(point => `${x(point.time_utc)},${42 - (point.reserve_wh / capacity) * 22}`).join(" ");
  const solarMax = power.series.reduce((peak, sample) => Math.max(peak, sample.vertical_w), 0);
  const solar = power.series.map(point => `${x(point.time_utc)},${62 - (solarMax > 0 ? point.vertical_w / solarMax : 0) * 16}`).join(" ");
  return <svg className="powered-contact-timeline" viewBox="0 0 100 64" preserveAspectRatio="none" aria-hidden="true">
    <rect x={x(row.request.time_range.start_utc)} y="2" width={x(row.request.time_range.end_utc) - x(row.request.time_range.start_utc)} height="14" rx="1" fill="#3d4d49" />
    {result.dte_windows.map(window =>
      <rect key={window.start_utc} x={x(window.start_utc)} y="10" width={x(window.end_utc) - x(window.start_utc)} height="6" rx=".6" fill="#c2a5ed" />,
    )}
    {result.windows.map(window =>
      <rect key={window.start_utc} x={x(window.start_utc)} y="2" width={x(window.end_utc) - x(window.start_utc)} height="6" rx=".6" fill="#83dbb7" />,
    )}
    <polyline points={reserve} fill="none" stroke="#7ac9f9" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    <polyline points={solar} fill="none" stroke="#f6cc80" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    {timeX >= 0 && timeX <= 100 && <line x1={timeX} x2={timeX} y1="0" y2="64" stroke="#e7f5ec" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
  </svg>;
}

export function PoweredContactWindow({ rows, name, minimumHours, onMinimumChange, clock }: {
  rows: Scenario[];
  name: (row: Scenario) => string;
  minimumHours: string;
  onMinimumChange: (value: string) => void;
  clock: number;
}) {
  if (!rows.length) return null;
  const minimum = Number(minimumHours);
  const validMinimum = Number.isFinite(minimum) && minimum > 0;
  const axis = {
    start: Math.min(...rows.map(row => Date.parse(row.request.time_range.start_utc))),
    end: Math.max(...rows.map(row => Date.parse(row.request.time_range.end_utc))),
  };
  return <section className="powered-contact" aria-labelledby="powered-contact-heading">
    <h3 id="powered-contact-heading">Powered contact windows</h3>
    <p>Find continuous periods when the payload can stay powered and Earth clears the modeled terrain by the configured margin.</p>
    <label className="field powered-contact-minimum">Minimum powered contact (hours)
      <input type="number" min="0" step="any" value={minimumHours} onChange={event => onMinimumChange(event.target.value)} />
    </label>
    {!validMinimum && <p role="status">Enter a duration greater than zero.</p>}
    <ul className="powered-contact-legend" aria-label="Timeline legend"><li>Powered contact</li><li>Earth clearance</li><li>Battery reserve</li><li>Solar generation</li></ul>
    <p className="field-hint">Charts share one UTC axis. Each reserve line uses its battery capacity. Each solar line uses its own peak output.</p>
    <div className="powered-contact-axis"><span>{utcTime(new Date(axis.start).toISOString())}</span><span>{utcTime(new Date(axis.end).toISOString())}</span></div>
    {rows.map(row => {
      const result = getPoweredContact(row);
      const power = row.site.power;
      const longest = result && longestPoweredWindow(result);
      const meets = result && meetsPoweredContact(result, minimum);
      const inside = clock >= Date.parse(row.request.time_range.start_utc) && clock < Date.parse(row.request.time_range.end_utc);
      const selectedState = result && poweredContactAt(result, clock);
      const battery = power?.battery;
      return <article key={row.key} className="powered-contact-row">
        <h4>{name(row)} · {utcTime(row.request.time_range.start_utc)}</h4>
        {result && power ? <>
          <ModelTimeline row={row} result={result} axis={axis} clock={clock} />
          <p className="powered-contact-readout" aria-live="polite">
            {validMinimum && <strong className={meets ? "window-met" : "window-missed"}>{meets ? "Meets requirement" : "Falls short"} · </strong>}
            {hours(result.longest_contact_hours)} longest powered contact
          </p>
          {longest && <p>{utcTime(longest.start_utc)} → {utcTime(longest.end_utc)}</p>}
          {row.site.dte && <p>{hours(row.site.dte.longest_contact_hours)} longest interval with Earth clearance alone</p>}
          {result.windows.length > 1 && <details>
            <summary>All {result.windows.length} powered contact windows</summary>
            <ul>{result.windows.map(window => <li key={window.start_utc}>{utcTime(window.start_utc)} → {utcTime(window.end_utc)} · {hours(window.duration_hours)}</li>)}</ul>
          </details>}
          <p>At {utcTime(new Date(clock).toISOString())}: {inside ? (selectedState ? "powered contact available" : "no powered contact") : "outside this scenario"}</p>
          <p>{result.min_reserve_wh.toFixed(1)} Wh minimum reserve{result.first_depletion_utc ? ` · First modeled depletion ${utcTime(result.first_depletion_utc)}` : " · No modeled depletion"}</p>
          <details>
            <summary>Power and clearance assumptions</summary>
            <p>{power.assumptions.area_m2} m² vertical tracking panel at {(power.assumptions.efficiency * 100).toFixed(1)}% efficiency{battery && ` · ${battery.load_w} W constant load · ${battery.capacity_wh} Wh battery, ${(battery.start_soc * 100).toFixed(0)}% initial charge`} · Earth-center clearance above terrain greater than {row.site.dte?.margin_deg ?? row.request.dte_margin_deg ?? 2}°.</p>
            {power.assumptions.excludes?.length && <p>The power model excludes {power.assumptions.excludes.join(", ")}.</p>}
          </details>
        </> : <p>Powered contact needs a V2 science analysis for this scenario.</p>}
      </article>;
    })}
    <p className="field-hint">Window calculations use the native science samples. The power and reserve lines display fewer points. Modeled operation ends at the first battery outage, with no restart. Earth clearance is geometric and does not predict radio-link reliability.</p>
  </section>;
}
