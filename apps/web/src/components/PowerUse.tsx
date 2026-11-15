import { useId, useMemo } from "react";
import type { Scenario } from "../lib/scenarios";
import { COMPARE_COLORS } from "../lib/sky-geometry";
import "./power-use.css";

const kwh = (wh: number) => `${(wh / 1000).toFixed(2)} kWh`;
const day = new Intl.DateTimeFormat("en-GB", { month: "short", day: "numeric", timeZone: "UTC" });
const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

interface Trace { key: string; label: string; color: string; net: [number, number][]; reserve: [number, number][];
  load: number; capacity: number; generated: number; used: number; minimum: number; depleted?: number }

/** Battery reserve under a constant load, stepping through the backend's solar samples. */
function simulateReserve(series: { time: number; watts: number }[], load: number, capacity: number, startSoc: number, end: number) {
  let reserve = capacity * startSoc;
  const out: [number, number][] = [];
  let depleted: number | undefined;
  series.forEach((point, index) => {
    out.push([point.time, reserve]);
    const next = Math.min(series[index + 1]?.time ?? end, end);
    const hoursStep = Math.max(0, next - point.time) / 3_600_000;
    reserve = Math.min(capacity, reserve + (point.watts - load) * hoursStep);
    if (reserve <= 0 && depleted == null) depleted = next;
    reserve = Math.max(0, reserve);
  });
  if (series.length) out.push([end, reserve]);
  return { out, depleted };
}

/**
 * Estimated power use over the mission for each compared site: what the panels
 * make (NASA SPICE Sun geometry with LOLA horizons) against a constant load,
 * and the battery reserve that leaves. The load and battery are mission inputs.
 */
export function PowerUse({ rows, name, start, end }: { rows: Scenario[]; name: (row: Scenario, index: number) => string; start: number; end: number }) {
  const id = useId();
  const traces = useMemo(() => rows.flatMap((row, index): Trace[] => {
    const power = row.site.power;
    if (!power?.series.length) return [];
    const settings = row.request.power ?? {};
    const load = power.battery?.load_w ?? settings.load_w ?? 150;
    const capacity = power.battery?.capacity_wh ?? settings.capacity_wh ?? 2000;
    const startSoc = power.battery?.start_soc ?? settings.start_soc ?? 1;
    const windowStart = Date.parse(row.request.time_range.start_utc), windowEnd = Date.parse(row.request.time_range.end_utc);
    const series = power.series.map(sample => ({ time: Date.parse(sample.time_utc), watts: sample.vertical_w }))
      .filter(point => point.time >= windowStart && point.time <= windowEnd).sort((a, b) => a.time - b.time);
    const server = power.powered_contact?.reserve_series;
    const simulated = simulateReserve(series, load, capacity, startSoc, windowEnd);
    const reserve: [number, number][] = server?.length ? server.map(point => [Date.parse(point.time_utc), point.reserve_wh]) : simulated.out;
    const hoursLong = (windowEnd - windowStart) / 3_600_000;
    const firstDepletion = power.powered_contact?.first_depletion_utc;
    return [{
      key: row.key, label: name(row, index), color: COMPARE_COLORS[index % COMPARE_COLORS.length],
      net: series.map(point => [point.time, point.watts - load]), reserve, load, capacity,
      generated: power.energy_wh, used: load * hoursLong,
      minimum: Math.min(...reserve.map(point => point[1])),
      depleted: firstDepletion ? Date.parse(firstDepletion) : server?.length ? undefined : simulated.depleted,
    }];
  }), [rows, name]);

  if (!traces.length || !(end > start)) return null;
  const x = (time: number) => (time - start) * 1000 / (end - start);
  const netMax = Math.max(1, ...traces.flatMap(trace => trace.net.map(point => point[1])));
  const netMin = Math.min(-1, ...traces.flatMap(trace => trace.net.map(point => point[1])));
  const capMax = Math.max(1, ...traces.map(trace => trace.capacity));
  const yNet = (value: number) => 100 - (value - netMin) * 100 / (netMax - netMin);
  const yRes = (value: number) => 100 - value * 100 / capMax;
  const path = (points: [number, number][], y: (value: number) => number) => points.map(([time, value]) => `${x(time).toFixed(1)},${y(value).toFixed(2)}`).join(" ");
  const loads = new Set(traces.map(trace => trace.load)), capacities = new Set(traces.map(trace => trace.capacity));
  const ticks = [start, (start + end) / 2, end];

  return <section className="power-use" aria-labelledby={id}>
    <header>
      <h3 id={id}>Estimated power use over time</h3>
      <p>{loads.size === 1 ? `${[...loads][0]} W constant load` : "Constant load per site"}{capacities.size === 1 ? ` · ${kwh([...capacities][0])} battery` : ""} · solar from NASA SPICE Sun positions and LOLA horizons</p>
    </header>
    <ul className="power-use-legend">{traces.map(trace => <li key={trace.key}><i style={{ background: trace.color }} />{trace.label}</li>)}</ul>

    <div className="power-use-charts">
      <figure>
        <figcaption>Net power · generation minus load (W)</figcaption>
        <div className="power-use-plot">
          <div className="power-use-y" aria-hidden="true"><span>{Math.round(netMax)}</span><span>0</span><span>{Math.round(netMin)}</span></div>
          <svg viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label="Net power for each site over the mission">
            <rect x="0" y={yNet(0)} width="1000" height={Math.max(0, 100 - yNet(0))} className="power-use-deficit" />
            <line x1="0" x2="1000" y1={yNet(0)} y2={yNet(0)} className="power-use-zero" />
            {traces.map(trace => <polyline key={trace.key} points={path(trace.net, yNet)} stroke={trace.color} />)}
          </svg>
        </div>
        <div className="power-use-axis" aria-hidden="true">{ticks.map(time => <span key={time}>{day.format(time)}<small>{clock.format(time)}</small></span>)}</div>
      </figure>
      <figure>
        <figcaption>Battery reserve (Wh)</figcaption>
        <div className="power-use-plot">
          <div className="power-use-y" aria-hidden="true"><span>{Math.round(capMax)}</span><span>{Math.round(capMax / 2)}</span><span>0</span></div>
          <svg viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label="Battery reserve for each site over the mission">
            {[0, .5, 1].map(f => <line key={f} x1="0" x2="1000" y1={yRes(capMax * f)} y2={yRes(capMax * f)} className="power-use-grid" />)}
            {traces.map(trace => <polyline key={trace.key} points={path(trace.reserve, yRes)} stroke={trace.color} />)}
            {traces.filter(trace => trace.depleted != null).map(trace => <line key={`${trace.key}-out`} x1={x(trace.depleted!)} x2={x(trace.depleted!)} y1="0" y2="100" stroke={trace.color} className="power-use-out" />)}
          </svg>
        </div>
        <div className="power-use-axis" aria-hidden="true">{ticks.map(time => <span key={time}>{day.format(time)}<small>{clock.format(time)}</small></span>)}</div>
      </figure>
    </div>

    <table className="comparison-table power-use-table">
      <thead><tr><th scope="col">Site</th><th scope="col">Generated</th><th scope="col">Used</th><th scope="col">Balance</th><th scope="col">Lowest reserve</th><th scope="col">Battery runs out</th></tr></thead>
      <tbody>{traces.map(trace => <tr key={trace.key}>
        <th scope="row"><i style={{ background: trace.color }} />{trace.label}</th>
        <td>{kwh(trace.generated)}</td>
        <td>{kwh(trace.used)}</td>
        <td className={trace.generated - trace.used >= 0 ? "power-use-surplus" : "power-use-short"}>{trace.generated - trace.used >= 0 ? "+" : "−"}{kwh(Math.abs(trace.generated - trace.used))}</td>
        <td>{Math.round(trace.minimum)} Wh</td>
        <td>{trace.depleted == null ? "Never" : `${day.format(trace.depleted)} ${clock.format(trace.depleted)} UTC`}</td>
      </tr>)}</tbody>
    </table>
    <p className="power-use-note">Generation is ideal direct sunlight on a 1 m², 30%-efficient vertical tracking panel unless changed. It excludes dust, temperature, degradation and conversion losses.</p>
  </section>;
}
