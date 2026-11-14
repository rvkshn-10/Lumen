import type { CoverageCatalog } from "../lib/planning";
import { appliedConstraints, presetNames, priorityName } from "../lib/planning";
import type { LunarFeature, SearchRequest } from "../lib/types";
import { MISSION_PRESETS } from "../lib/missions";
import { normalizePreferences } from "../lib/weights";
import { MissionBrief } from "./MissionBrief";
import { MissionDateFields, MissionRequirementFields } from "./MissionFields";

export function PlanningMission({ request, catalog, features, onChange }: {
  request: SearchRequest; catalog: CoverageCatalog; features: LunarFeature[]; onChange: (request: SearchRequest) => void;
}) {
  const weights = normalizePreferences(request.preferences);
  return <>
    <MissionBrief value={request} catalog={catalog} features={features} onApply={onChange} />
    <MissionDateFields request={request} catalog={catalog} onChange={onChange} />
    <fieldset className="preset-fieldset"><legend>What would you like to prioritize?</legend><div className="preset-grid">{MISSION_PRESETS.slice(0, 3).map((preset, index) => <button type="button" key={preset.id} aria-pressed={priorityName(request) === presetNames[index]}
      onClick={() => onChange({ ...request, preferences: structuredClone(preset.request.preferences), hard_constraints: structuredClone(preset.request.hard_constraints) })}>
      <strong>{presetNames[index]}</strong><span>{index === 0 ? "Balance sunlight, Earth view and terrain." : index === 1 ? "Give sunlight more influence in ranking." : "Give Earth visibility more influence in ranking."}</span>
    </button>)}</div></fieldset>
    <p className="priority-readout">Applied priorities: {Math.round(weights.illumination * 100)}% sunlight · {Math.round(weights.earth_visibility * 100)}% Earth view · {Math.round(weights.terrain_safety * 100)}% terrain · {Math.round(weights.science_proximity * 100)}% science proximity.</p>
    <p className="field-hint">Required limits from this configuration: {appliedConstraints(request).join("; ") || "none"}. A preset replaces priorities and limits; it keeps your area and dates.</p>
    <details className="advanced-mission"><summary>Advanced · required limits and custom priorities</summary>
      <MissionRequirementFields request={request} catalog={catalog} features={features} onChange={onChange} />
      <p className="field-hint">Slope/roughness are published 100 m-baseline measurements sampled on 1 km output grids. Source-pixel scale is not accuracy. PSR proximity is not evidence of accessible ice.</p>
    </details>
  </>;
}
