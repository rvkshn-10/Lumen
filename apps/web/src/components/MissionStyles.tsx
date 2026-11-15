import type { SearchRequest } from "../lib/types";
import type { CoverageCatalog } from "../lib/planning";
import { appliedConstraints, usesHemisphereTerrain } from "../lib/planning";
import type { LunarFeature } from "../lib/types";
import type { MissionStyle } from "../lib/mission-styles";
import { MISSION_STYLES, activeStyle } from "../lib/mission-styles";
import type { RankingStatus } from "../lib/background-ranking";
import { normalizePreferences } from "../lib/weights";
import { MissionDateFields, MissionRequirementFields } from "./MissionFields";
import { MissionBrief } from "./MissionBrief";
import "./mission-styles.css";

export function MissionStyles({ request, catalog, features, chosen, ranking, rankingKey, onPick, onChange, onOpenLibrary }: {
  request: SearchRequest; catalog: CoverageCatalog; features: LunarFeature[];
  /** A style has been clicked at least once, so ranking runs in the background. */
  chosen: boolean;
  ranking: RankingStatus; rankingKey: string;
  onPick: (style: MissionStyle) => void; onChange: (request: SearchRequest) => void; onOpenLibrary: () => void;
}) {
  const current = activeStyle(request);
  const psr = !!catalog.layers.psr_distance && !usesHemisphereTerrain(request);
  const weights = normalizePreferences(request.preferences);
  const limits = appliedConstraints(request);
  const mine = ranking?.key === rankingKey ? ranking : null;
  return <div className="mission-styles-form">
    <section aria-labelledby="mission-window-label">
      <h2 id="mission-window-label">Mission window</h2>
      <MissionDateFields request={request} catalog={catalog} onChange={onChange} />
    </section>
    <section aria-labelledby="mission-style-label">
      <div className="mission-style-head">
        <h2 id="mission-style-label">Mission style</h2>
        {chosen && <p className={`ranking-chip ${mine?.state ?? "waiting"}`} role="status" aria-live="polite">
          <i aria-hidden="true" />{mine?.state === "ready" ? "Leaderboard ready" : mine?.state === "failed" ? mine.message ?? "Ranking failed" : mine ? "Ranking in the background…" : "Waiting for valid dates…"}
        </p>}
      </div>
      <div className="mission-style-grid" role="radiogroup" aria-label="Mission style">
        {MISSION_STYLES.filter(style => style.needs !== "psr" || psr).map(style => <button type="button" role="radio" key={style.id}
          aria-checked={chosen && current?.id === style.id} className="mission-style-card" onClick={() => onPick(style)}>
          <strong>{style.name}</strong>
          <span>{style.blurb}</span>
        </button>)}
      </div>
      {!chosen && <p className="field-hint">Ranking starts the moment you pick a style.</p>}
    </section>
    <details className="advanced-mission mission-options">
      <summary>Custom weights &amp; limits{limits.length > 0 && <span className="field-hint"> · {limits.length} set</span>}</summary>
      <p className="priority-readout">{Math.round(weights.illumination * 100)}% sunlight · {Math.round(weights.earth_visibility * 100)}% Earth view · {Math.round(weights.terrain_safety * 100)}% terrain · {Math.round(weights.science_proximity * 100)}% science proximity</p>
      <MissionRequirementFields request={request} catalog={catalog} features={features} onChange={onChange} />
      <MissionBrief value={request} catalog={catalog} features={features} onApply={onChange} />
      <button type="button" className="text-button" onClick={onOpenLibrary}>Saved missions</button>
    </details>
  </div>;
}
