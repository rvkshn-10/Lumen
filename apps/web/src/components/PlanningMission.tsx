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
  const limits = appliedConstraints(request);
  return (
    <div className="guide-mission-form">
      <section aria-labelledby="mission-window-label">
        <h2 id="mission-window-label">Mission window</h2>
        <MissionDateFields request={request} catalog={catalog} onChange={onChange} />
      </section>
      <fieldset className="preset-fieldset">
        <legend>Ranking priority</legend>
        <div className="preset-grid">{MISSION_PRESETS.slice(0, 3).map((preset, index) => (
          <button type="button" key={preset.id} aria-pressed={priorityName(request) === presetNames[index]}
            onClick={() => onChange({ ...request, preferences: structuredClone(preset.request.preferences), hard_constraints: structuredClone(preset.request.hard_constraints) })}>
            {presetNames[index]}
          </button>
        ))}</div>
        <p className="field-hint">A priority preset also sets its required limits.</p>
      </fieldset>
      <details className="advanced-mission">
        <summary>Requirements &amp; custom weights{limits.length ? <> <span className="field-hint">· {limits.length} set</span></> : null}</summary>
        <p className="priority-readout">{Math.round(weights.illumination * 100)}% sunlight · {Math.round(weights.earth_visibility * 100)}% Earth view · {Math.round(weights.terrain_safety * 100)}% terrain · {Math.round(weights.science_proximity * 100)}% science proximity</p>
        <MissionRequirementFields request={request} catalog={catalog} features={features} onChange={onChange} />
        <p className="field-hint">Slope and roughness use a 100 m baseline on 1 km grids. PSR distance indicates proximity to modeled permanent shadow.</p>
      </details>
      <MissionBrief value={request} catalog={catalog} features={features} onApply={onChange} />
    </div>
  );
}
