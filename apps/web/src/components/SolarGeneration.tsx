import { useId, useMemo, useState } from "react";
import { utcTime } from "../lib/format";
import type { Scenario } from "../lib/scenarios";
import { nearestSolarPoint, solarSegments } from "../lib/solar-generation";
import "./solar-generation.css";

const traceStyles = [
  { color: "var(--text-primary)", dash: undefined },
  { color: "var(--text-secondary)", dash: "7 4" },
  { color: "var(--text-primary)", dash: "2 4" },
  { color: "var(--text-secondary)", dash: "12 4 2 4" },
];
const watts = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const tickWatts = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
const fullTime = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const day = new Intl.DateTimeFormat("en-GB", { month: "short", day: "numeric", timeZone: "UTC" });
const datedYear = new Intl.DateTimeFormat("en-GB", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const clockTime = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

function powerTicks(peak: number) {
  const upper = Math.max(peak, 1);
  const magnitude = 10 ** Math.floor(Math.log10(upper / 5));
  const step = ([1, 2, 2.5, 5, 10].find(unit => unit * magnitude >= upper / 5) ?? 10) * magnitude;
  return Array.from({ length: Math.ceil(upper / step) + 1 }, (_, index) => index * step);
}

export function SolarGeneration({ rows, name, start, end }: {
  rows: Scenario[];
  name: (row: Scenario) => string;
  start: number;
  end: number;
}) {
  const id = useId();
  const [sampleIndex, setSampleIndex] = useState(0);
  const [showReadings, setShowReadings] = useState(false);
  const { traces, samples, ticks } = useMemo(() => {
    const samples = new Set<number>();
    let peak = 0;
    const traces = rows.map(row => {
      const power = row.site.power;
      const segments = solarSegments(
        power?.series, Date.parse(row.request.time_range.start_utc), Date.parse(row.request.time_range.end_utc),
      );
      for (const segment of segments) {
        for (const point of segment) {
          samples.add(point.time);
          peak = Math.max(peak, point.watts);
        }
      }
      const repeated = rows.some(other => other.key !== row.key && name(other) === name(row));
      const label = repeated ? `${name(row)} · ${fullTime.format(Date.parse(row.request.time_range.start_utc))}` : name(row);
      const panel = power?.assumptions;
      const settings = panel ? `${tickWatts.format(panel.area_m2)} m², ${tickWatts.format(panel.efficiency * 100)}% efficiency` : "";
      return { key: row.key, label, segments, settings };
    });
    return { traces, samples: Array.from(samples).sort((a, b) => a - b), ticks: powerTicks(peak).reverse() };
  }, [name, rows]);

  if (samples.length === 0 || !(end > start)) {
    return <section className="solar-generation" aria-labelledby={id}>
      <h3 id={id}>Estimated solar generation</h3>
      <p className="field-hint">Solar power samples are unavailable for the selected scenarios.</p>
    </section>;
  }

  const sample = samples[Math.min(sampleIndex, samples.length - 1)];
  const peakAxis = ticks[0];
  const x = (time: number) => (time - start) * 1000 / (end - start);
  const y = (value: number) => 100 - value * 100 / peakAxis;
  const singleDay = new Date(start).toISOString().slice(0, 10) === new Date(end).toISOString().slice(0, 10);
  const dateLabel = new Date(start).getUTCFullYear() === new Date(end).getUTCFullYear() ? day : datedYear;
  const sampleLabel = fullTime.format(sample) + " UTC";
  const panelSettings = new Set(traces.filter(trace => trace.segments.length > 0).map(trace => trace.settings));
  const commonSettings = panelSettings.size === 1 ? panelSettings.values().next().value : undefined;

  return <section className="solar-generation" aria-labelledby={id}>
    <h3 id={id}>Estimated solar generation</h3>
    <p className="solar-assumptions" id={`${id}-assumptions`}>
      Vertical tracking panels{commonSettings ? ` · ${commonSettings}` : ""}
    </p>
    <ul className="solar-legend" aria-label="Solar generation series">
      {traces.map(({ key, label, segments, settings }, index) => <li key={key}>
        {segments.length > 0 && <svg width="26" height="8" aria-hidden="true">
          <line x1="0" x2="26" y1="4" y2="4" stroke={traceStyles[index].color}
            strokeWidth="2" strokeDasharray={traceStyles[index].dash} />
        </svg>}
        <span>{label}{!segments.length ? " · No power samples" : panelSettings.size > 1 ? ` · ${settings}` : ""}</span>
      </li>)}
    </ul>
    <div className="solar-frame">
      <span className="solar-unit">Power (W)</span>
      <div className="solar-y-labels" aria-hidden="true">
        {ticks.map(tick => <span key={tick}>{tickWatts.format(tick)}</span>)}
      </div>
      <svg className="solar-plot" viewBox="0 0 1000 100" preserveAspectRatio="none" role="img"
        aria-label="Time series of estimated solar power in watts"
        aria-describedby={`${id}-assumptions ${id}-description`}>
        {ticks.map(tick => <line className="solar-gridline" key={tick}
          x1="0" x2="1000" y1={y(tick)} y2={y(tick)} />)}
        {traces.map(({ key, segments }, index) => <g key={key} data-solar-trace={segments.length > 0 ? index : undefined}
          stroke={traceStyles[index].color} strokeDasharray={traceStyles[index].dash}>
          {segments.map(points => points.length === 1
            ? <line className="solar-line" key={points[0].time} x1={x(points[0].time)} x2={x(points[0].time)}
              y1={y(points[0].watts)} y2={y(points[0].watts)} strokeDasharray="none" strokeLinecap="round" />
            : <polyline className="solar-line" key={points[0].time}
              points={points.map(point => `${x(point.time).toFixed(2)},${y(point.watts).toFixed(2)}`).join(" ")} />)}
        </g>)}
        {showReadings && <line className="solar-cursor" x1={x(sample)} x2={x(sample)} y1="0" y2="100" />}
      </svg>
      <div className="solar-x-labels" aria-hidden="true">
        {[start, (start + end) / 2, end].map(time => <span key={time}>{singleDay
          ? clockTime.format(time)
          : <>{dateLabel.format(time)}<small>{clockTime.format(time)}</small></>}</span>)}
      </div>
      <span className="solar-time-unit">Mission time (UTC){singleDay ? ` · ${datedYear.format(start)}` : ""}</span>
    </div>
    <p className="sr-only" id={`${id}-description`}>
      {fullTime.format(start)} to {fullTime.format(end)} UTC. Open Readings to inspect power at a time.
    </p>
    <details className="solar-readings" onToggle={event => setShowReadings(event.currentTarget.open)}>
      <summary>Readings</summary>
      <label className="field">Mission time
        <output>{sampleLabel}</output>
        <input type="range" min={0} max={samples.length - 1} value={Math.min(sampleIndex, samples.length - 1)}
          aria-label="Solar reading time" aria-valuetext={sampleLabel} disabled={samples.length < 2}
          onChange={event => setSampleIndex(Number(event.target.value))} />
      </label>
      <dl>
        {traces.map(trace => {
          const point = nearestSolarPoint(trace.segments, sample);
          return <div key={trace.key}>
            <dt>{trace.label}</dt>
            <dd>{point ? <>{watts.format(point.watts)} W{point.time !== sample && <small>{utcTime(new Date(point.time).toISOString())}</small>}</> : "No sample"}</dd>
          </div>;
        })}
      </dl>
    </details>
  </section>;
}
