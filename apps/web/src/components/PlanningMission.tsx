import type { CoverageCatalog } from "../lib/planning";
import { appliedConstraints, presetNames, priorityName, usesHemisphereTerrain } from "../lib/planning";
import type { LunarFeature, SearchRequest } from "../lib/types";
import { MISSION_PRESETS } from "../lib/missions";
import { normalizePreferences } from "../lib/weights";
import { MissionBrief } from "./MissionBrief";
import { MissionDateFields, MissionRequirementFields } from "./MissionFields";

export function PlanningMission({ request, catalog, features, onChange, onOpenLibrary }: {
  request: SearchRequest;
  catalog: CoverageCatalog;
  features: LunarFeature[];
  onChange: (request: SearchRequest) => void;
  onOpenLibrary: () => void;
}) {
  const weights = normalizePreferences(request.preferences);
  const limits = appliedConstraints(request);
  const priority = priorityName(request);
  const isCustom = !presetNames.includes(priority);
  return (
    <div className="guide-mission-form">
      <section aria-labelledby="mission-window-label">
        <h2 id="mission-window-label">Mission window</h2>
        <MissionDateFields request={request} catalog={catalog} onChange={onChange} />
      </section>
      <div className="mission-priority">
        <label className="field">
          <strong>Mission priority</strong>
          <select value={priority} aria-describedby="mission-priority-hint" onChange={event => {
            const preset = MISSION_PRESETS[presetNames.indexOf(event.target.value)];
            if (preset) onChange({
              ...request,
              preferences: structuredClone(preset.request.preferences),
              hard_constraints: structuredClone(preset.request.hard_constraints),
            });
          }}>
            {isCustom && <option>{priority}</option>}
            {presetNames.map(name => <option key={name}>{name}</option>)}
          </select>
        </label>
        <p className="field-hint" id="mission-priority-hint">Choosing a preset also applies its required limits.</p>
      </div>
      <details className="advanced-mission mission-options">
        <summary>More options</summary>
        <details className="advanced-mission">
          <summary>Requirements &amp; custom weights{limits.length > 0 && <span className="field-hint"> · {limits.length} set</span>}</summary>
          <p className="priority-readout">{Math.round(weights.illumination * 100)}% sunlight · {Math.round(weights.earth_visibility * 100)}% Earth view · {Math.round(weights.terrain_safety * 100)}% terrain · {Math.round(weights.science_proximity * 100)}% science proximity</p>
          <MissionRequirementFields request={request} catalog={catalog} features={features} onChange={onChange} />
          <p className="field-hint">{usesHemisphereTerrain(request) ? "Slope uses a 500 m central-difference baseline; roughness is plane-residual RMS over a 500 m footprint." : "Slope and roughness use a 100 m baseline on 1 km grids. PSR distance indicates proximity to modeled permanent shadow."}</p>
        </details>
        <MissionBrief value={request} catalog={catalog} features={features} onApply={onChange} />
        <button type="button" className="text-button" onClick={onOpenLibrary}>Saved missions</button>
      </details>
    </div>
  );
}
