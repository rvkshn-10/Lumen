import type { Scenario } from "../lib/scenarios";
import type { SearchRequest } from "../lib/types";
import { compareSiteLabel } from "../lib/compare-sites";

const number = (value: number | undefined | null, unit = "", digits = 3) =>
  value == null || !Number.isFinite(value) ? "Unavailable" : `${value.toFixed(digits)}${unit ? ` ${unit}` : ""}`;
const fraction = (value: number | undefined) => value == null ? "Unavailable" : number(value * 100, "%", 4);
type Measure = { label: string; key: string; read: (row: Scenario) => string };
const terrain: Measure[] = [
  { label: "Latitude", key: "latitude_deg", read: r => number(r.site.latitude_deg, "°", 6) },
  { label: "Longitude east", key: "longitude_deg_east", read: r => number(r.site.longitude_deg_east, "°", 6) },
  { label: "Elevation", key: "elevation_m", read: r => number(r.site.elevation_m, "m") },
  { label: "Slope", key: "slope_deg", read: r => number(r.site.slope_deg, "°") },
  { label: "Roughness", key: "roughness_m", read: r => number(r.site.roughness_m, "m") },
  { label: "Planning score", key: "score", read: r => number(r.site.score, "/ 100", 4) },
];
const visibility: Measure[] = [
  { label: "Mean visible solar disk", key: "mean_visible_solar_disk_fraction", read: r => fraction(r.site.metrics.mean_visible_solar_disk_fraction) },
  { label: "Longest continuous sunlight", key: "longest_sunlight_hours", read: r => number(r.site.metrics.longest_sunlight_hours, "h") },
  { label: "Longest continuous Earth visibility", key: "longest_communication_hours", read: r => number(r.site.metrics.longest_communication_hours, "h") },
  { label: "Longest Earth blackout", key: "longest_blackout_hours", read: r => number(r.site.metrics.longest_blackout_hours, "h") },
  { label: "Earth contact with margin", key: "dte.contact_fraction", read: r => fraction(r.site.dte?.contact_fraction) },
  { label: "Longest contact with margin", key: "dte.longest_contact_hours", read: r => number(r.site.dte?.longest_contact_hours, "h") },
  { label: "Contact elevation margin", key: "dte.margin_deg", read: r => number(r.site.dte?.margin_deg, "°") },
  { label: "Longest powered contact", key: "powered_contact.longest_contact_hours", read: r => number(r.site.power?.powered_contact?.longest_contact_hours, "h") },
];
const power: Measure[] = [
  { label: "Tracking panel energy", key: "energy_wh", read: r => number(r.site.power?.energy_wh, "Wh") },
  { label: "Horizontal panel energy", key: "horizontal_energy_wh", read: r => number(r.site.power?.horizontal_energy_wh, "Wh") },
  { label: "Panel area", key: "area_m2", read: r => number(r.site.power?.assumptions.area_m2, "m²") },
  { label: "Panel efficiency", key: "efficiency", read: r => fraction(r.site.power?.assumptions.efficiency) },
  { label: "Solar irradiance at 1 AU", key: "solar_constant_w_m2", read: r => number(r.site.power?.assumptions.solar_constant_w_m2, "W/m²") },
  { label: "Equipment load", key: "load_w", read: r => number(r.site.power?.battery?.load_w ?? r.request.power?.load_w, "W") },
  { label: "Battery capacity", key: "capacity_wh", read: r => number(r.site.power?.battery?.capacity_wh ?? r.request.power?.capacity_wh, "Wh") },
  { label: "Initial state of charge", key: "start_soc", read: r => fraction(r.site.power?.battery?.start_soc ?? r.request.power?.start_soc) },
  { label: "Minimum battery reserve", key: "min_reserve_wh", read: r => number(r.site.power?.powered_contact?.min_reserve_wh ?? r.site.power?.battery?.min_soc_wh, "Wh") },
];
const limits: { key: Exclude<keyof SearchRequest["hard_constraints"], "science_feature_ids">; label: string; unit: string; percent?: boolean }[] = [
  { key: "maximum_slope_deg", label: "Maximum slope", unit: "°" },
  { key: "maximum_roughness_m", label: "Maximum roughness", unit: "m" },
  { key: "minimum_elevation_m", label: "Minimum elevation", unit: "m" },
  { key: "maximum_elevation_m", label: "Maximum elevation", unit: "m" },
  { key: "minimum_illumination_fraction", label: "Minimum sunlight", unit: "%", percent: true },
  { key: "minimum_earth_visibility_fraction", label: "Minimum Earth visibility", unit: "%", percent: true },
  { key: "maximum_continuous_darkness_hours", label: "Maximum continuous darkness", unit: "h" },
  { key: "maximum_continuous_blackout_hours", label: "Maximum continuous blackout", unit: "h" },
  { key: "minimum_continuous_sunlight_hours", label: "Minimum continuous sunlight", unit: "h" },
  { key: "minimum_continuous_communication_hours", label: "Minimum continuous Earth visibility", unit: "h" },
  { key: "maximum_distance_to_psr_km", label: "Maximum PSR distance", unit: "km" },
  { key: "maximum_distance_to_science_feature_km", label: "Maximum feature distance", unit: "km" },
];

function Measures({ title, rows, measures }: { title: string; rows: Scenario[]; measures: Measure[] }) {
  return <section className="engineer-section" aria-label={title}>
    <h3>{title}</h3>
    <div className="engineer-table-scroll" role="region" aria-label={`${title} values`} tabIndex={0}>
      <table className="engineer-table"><thead><tr><th scope="col">Measure</th>{rows.map((row, index) => <th scope="col" key={row.key}>{compareSiteLabel(index)}</th>)}</tr></thead>
        <tbody>{measures.map(measure => <tr key={measure.key}><th scope="row">{measure.label}<code>{measure.key}</code></th>
          {rows.map(row => <td key={row.key}>{measure.read(row)}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

/** Detailed evidence already returned with each scenario; no extra analysis calls. */
export function EngineerComparison({ rows }: { rows: Scenario[] }) {
  const activeLimits: Measure[] = limits.filter(limit => rows.some(row => row.request.hard_constraints[limit.key] != null)).map(limit => ({
    label: limit.label, key: limit.key, read: row => {
      const value = row.request.hard_constraints[limit.key];
      return value == null ? "Not set" : number(value * (limit.percent ? 100 : 1), limit.unit);
    },
  }));
  return <div className="engineer-comparison">
    <header><h3>Engineering comparison</h3><p>Terrain, visibility, power inputs and mission limits for each scenario. Extra decimal places show calculation precision, not measurement accuracy.</p></header>
    <Measures title="Location and terrain" rows={rows} measures={terrain} />
    <Measures title="Visibility and contact" rows={rows} measures={visibility} />
    <Measures title="Power and battery model" rows={rows} measures={power} />
    <Measures title="Mission limits" rows={rows} measures={[
      { label: "Constraint result", key: "constraint_status.passes", read: r => r.constraint_status == null ? "Unavailable" : r.constraint_status.passes ? "Passes all applied limits" : "Does not pass all applied limits" },
      ...activeLimits,
      { label: "Selected science features", key: "science_feature_ids", read: r => r.request.hard_constraints.science_feature_ids?.join(", ") || "None selected" },
    ]} />
    <div className="engineer-scenarios">{rows.map((row, index) => {
      const samples = row.site.timeline;
      const cadence = [...new Set(samples.slice(1).map((sample, i) => (Date.parse(sample.time_utc) - Date.parse(samples[i].time_utc)) / 60000))];
      return <section className="engineer-scenario" key={row.key} aria-label={`${compareSiteLabel(index)} calculation inputs`}>
        <h3>{compareSiteLabel(index)} · Calculation inputs</h3>
        <dl>
          <div><dt>Site ID</dt><dd><code>{row.site.id}</code></dd></div>
          {row.provenance && <div><dt>Scientific provenance</dt><dd>{["dataset_version", "engine_version", "calculation_frame"].map(key => {
            const value = row.provenance?.[key];
            return typeof value === "string" ? <span className="engineer-weight" key={key}><code>{key}</code> {value}</span> : null;
          })}</dd></div>}
          <div><dt>Search scope</dt><dd>{row.request.region.selector_type === "southern_hemisphere" ? "Southern hemisphere regional survey · approximately 150 km spacing" : row.request.region.selector_type === "full_supported_region" ? "Prepared polar cap" : `Local area${row.request.region.search_radius_km == null ? "" : ` · ${row.request.region.search_radius_km} km radius`}`}</dd></div>
          <div><dt>Mission window (UTC)</dt><dd><time>{row.request.time_range.start_utc}</time> → <time>{row.request.time_range.end_utc}</time><br />{number((Date.parse(row.request.time_range.end_utc) - Date.parse(row.request.time_range.start_utc)) / 3600000, "h")}</dd></div>
          <div><dt>Timeline sampling</dt><dd>{samples.length.toLocaleString()} samples · {cadence.length ? `${cadence.map(n => number(n, "min")).join(" / ")} intervals` : "Cadence unavailable"}</dd></div>
          <div><dt>Horizon profile</dt><dd>{row.site.horizon.length} azimuth bearings · observer 2 m above terrain</dd></div>
          <div><dt>Requested priorities</dt><dd>{Object.entries(row.request.preferences).map(([key, value]) => <span className="engineer-weight" key={key}><code>{key}</code> {number(value, "", 4)}</span>)}</dd></div>
          <div><dt>Criterion utilities</dt><dd>{row.site.criteria_scores ? Object.entries(row.site.criteria_scores).map(([key, value]) => <span className="engineer-weight" key={key}><code>{key}</code> {number(value, "", 4)}</span>) : "Unavailable"}</dd></div>
          {row.site.dte && <div><dt>Contact definition</dt><dd>{row.site.dte.definition}</dd></div>}
          {row.site.power && <div><dt>Power integration and exclusions</dt><dd>{row.site.power.assumptions.integration || "Integration method not provided"}{row.site.power.assumptions.excludes?.length ? ` · Excludes: ${row.site.power.assumptions.excludes.join(", ")}.` : ""}</dd></div>}
          {!!row.warnings?.length && <div><dt>Scientific limitations</dt><dd><ul>{row.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></dd></div>}
        </dl>
      </section>;
    })}</div>
  </div>;
}
