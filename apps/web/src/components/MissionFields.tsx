import type { CoverageCatalog } from "../lib/planning";
import { constraintLabels, usesHemisphereTerrain } from "../lib/planning";
import type { LunarFeature, SearchRequest } from "../lib/types";

interface MissionFieldProps {
  request: SearchRequest;
  catalog: CoverageCatalog;
  onChange: (request: SearchRequest) => void;
}

export function MissionDateFields({ request, catalog, onChange }: MissionFieldProps) {
  const fullRegion = request.region.selector_type === "full_supported_region";
  const limits = catalog.public_limits;
  function setTimeRange(time_range: SearchRequest["time_range"]) {
    const next = { ...request, time_range };
    const cursor = Date.parse(request.scrub_time_utc ?? "");
    if (cursor < Date.parse(time_range.start_utc) || cursor > Date.parse(time_range.end_utc)) {
      next.scrub_time_utc = null;
    }
    onChange(next);
  }
  function updateDate(field: keyof SearchRequest["time_range"], input: string) {
    setTimeRange({ ...request.time_range, [field]: input ? `${input}:00Z` : "" });
  }
  return (
    <>
      <div className="guide-fields">
        <label className="field">
          Mission start (UTC)
          <input required type="datetime-local" value={request.time_range.start_utc.slice(0, 16)}
            onChange={event => updateDate("start_utc", event.target.value)} />
        </label>
        <label className="field">
          Mission end (UTC, exclusive)
          <input required type="datetime-local" value={request.time_range.end_utc.slice(0, 16)}
            onChange={event => updateDate("end_utc", event.target.value)} />
        </label>
      </div>
      <p className="field-hint">{fullRegion
        ? "Full-region searches use the prepared October 1–31, 2028 demonstration window."
        : request.region.selector_type === "southern_hemisphere" ? `Survey the southern hemisphere over up to ${limits.maximum_live_days} days, then refine shortlisted areas locally.` : `Live detailed missions: up to ${limits.maximum_live_days} days. Dates are checked against the service’s advertised ephemeris range.`}</p>
      {fullRegion && <button type="button" className="secondary-button" onClick={() => setTimeRange({
        start_utc: limits.full_region_start_utc, end_utc: limits.full_region_end_utc,
      })}>Apply October 2028 demo window</button>}
    </>
  );
}

type RequirementField = Exclude<keyof SearchRequest["hard_constraints"], "science_feature_ids">;

export function MissionRequirementFields({ request, catalog, features, onChange }: MissionFieldProps & { features: LunarFeature[] }) {
  const hemisphere = usesHemisphereTerrain(request);
  function setConstraint(field: RequirementField, value?: number) {
    const hard_constraints = { ...request.hard_constraints, [field]: value };
    if (value === undefined) delete hard_constraints[field];
    onChange({ ...request, hard_constraints });
  }
  return (
    <>
      <h3>Required limits</h3>
      <p>Locations must meet every applied limit before ranking. Leave a field blank to remove that requirement.</p>
      <div className="guide-fields">
        {Object.entries(constraintLabels).map(([key, label]) => {
          const field = key as RequirementField;
          const value = request.hard_constraints[field];
          const factor = key.endsWith("_fraction") ? 100 : 1;
          const unavailable = (key === "maximum_distance_to_psr_km" && (hemisphere || !catalog.layers.psr_distance)) || (hemisphere && key === "maximum_distance_to_science_feature_km");
          const missingFeature = !hemisphere && key === "maximum_distance_to_science_feature_km" && !request.hard_constraints.science_feature_ids?.length;
          const disabled = unavailable || missingFeature;
          return (
            <div className="field" key={key}>
              <label className="field">
                {label}
                <input type="number" step="any"
                  min={key.includes("elevation") ? undefined : 0}
                  max={factor === 100 ? 100 : key === "maximum_slope_deg" ? 90 : undefined}
                  value={typeof value === "number" ? value * factor : ""}
                  disabled={disabled}
                  onChange={event => setConstraint(field,
                    event.target.value === "" ? undefined : event.target.valueAsNumber / factor)} />
              </label>
              {disabled && value != null && <button type="button" className="text-button" onClick={() => setConstraint(field)}>
                Remove unavailable requirement
              </button>}
              {unavailable && <small>Unavailable for the selected terrain coverage.</small>}
              {missingFeature && <small>Select an approved science feature below to enable this limit.</small>}
            </div>
          );
        })}
      </div>
      <label className="field">
        Science feature centers
        <select multiple disabled={hemisphere} value={request.hard_constraints.science_feature_ids ?? []} onChange={event => onChange({
          ...request,
          hard_constraints: {
            ...request.hard_constraints,
            science_feature_ids: Array.from(event.target.selectedOptions, option => option.value),
          },
        })}>
          {features.map(feature => <option key={feature.id} value={feature.id}>{feature.name}</option>)}
        </select>
      </label>
      {hemisphere && <><p className="field-hint">PSR and named-feature proximity are unavailable in hemisphere searches. Imported requirements remain applied until you remove them.</p>{!!request.hard_constraints.science_feature_ids?.length && <button type="button" className="text-button" onClick={() => { const hard_constraints = { ...request.hard_constraints }; delete hard_constraints.science_feature_ids; delete hard_constraints.maximum_distance_to_science_feature_km; onChange({ ...request, hard_constraints }); }}>Remove unavailable feature requirements</button>}</>}
      <h3>Ranking preferences</h3>
      <p>Preferences change the score among eligible sites. They do not override required limits.</p>
      <div className="guide-fields">
        {Object.entries(request.preferences).map(([key, value]) => (
          <label className="field" key={key}>
            {key.replaceAll("_", " ")} weight
            <input type="number" min="0" step="any" value={value} onChange={event => onChange({
              ...request, preferences: { ...request.preferences, [key]: Number(event.target.value) },
            })} />
          </label>
        ))}
      </div>
    </>
  );
}
