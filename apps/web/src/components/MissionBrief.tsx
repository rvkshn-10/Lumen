import { useEffect, useId, useRef, useState } from "react";
import { CopilotUnavailableError, draftMissionBrief, validateSearch } from "../lib/api";
import type { MissionDraft } from "../lib/api";
import { interpretBrief } from "../lib/brief";
import { areaName } from "../lib/planning";
import type { CoverageCatalog } from "../lib/planning";
import type { LunarFeature, SearchRequest } from "../lib/types";
import { normalizePreferences } from "../lib/weights";
import { Icon } from "./Icon";
import { MissionDateFields, MissionRequirementFields } from "./MissionFields";
import { useCopilotAvailability } from "./useCopilotAvailability";

const examples = [
  ["Shackleton mission", "Within 3 km of Shackleton, 2028-10-05 to 2028-10-09, maximum slope 7°, prioritize sunlight."],
  ["Terrain first", "2028-11-06 to 2028-11-10, maximum slope 8°, prioritize terrain."],
];

type DraftReview = MissionDraft & {
  source: "Intel OpenVINO GenAI" | "Phrase parser";
};

export function MissionBrief({ value, catalog, features, onApply }: {
  value: SearchRequest;
  catalog: CoverageCatalog;
  features: LunarFeature[];
  onApply: (request: SearchRequest) => void;
}) {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<DraftReview | null>(null);
  const [edited, setEdited] = useState<SearchRequest | null>(null);
  const [pending, setPending] = useState<"draft" | "apply" | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const available = useCopilotAvailability(open);
  const request = edited ?? draft?.request;
  const validationErrors = edited ? [] : draft?.validation_errors ?? [];

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    controller.current?.abort();
    setDraft(null);
    setEdited(null);
    setPending(null);
    setError("");
  }, [value]);

  function resetReview() {
    controller.current?.abort();
    setDraft(null);
    setEdited(null);
    setPending(null);
    setNotice("");
    setError("");
  }

  function updateText(next: string) {
    setText(next);
    resetReview();
  }

  async function createDraft(useModel: boolean) {
    resetReview();
    if (!useModel) {
      setDraft({ ...interpretBrief(text, value, features), source: "Phrase parser" });
      return;
    }
    const next = new AbortController();
    controller.current = next;
    setPending("draft");
    try {
      const result = await draftMissionBrief(text.trim(), value, next.signal);
      if (!next.signal.aborted) setDraft({ ...result, source: "Intel OpenVINO GenAI" });
    } catch (reason) {
      if (next.signal.aborted) return;
      if (reason instanceof CopilotUnavailableError) {
        setDraft({ ...interpretBrief(text, value, features), source: "Phrase parser" });
        setNotice("OpenVINO is unavailable. The draft below uses the phrase parser.");
      } else {
        setError(reason instanceof Error ? reason.message : "Could not generate a mission draft.");
      }
    } finally {
      if (!next.signal.aborted) setPending(null);
    }
  }

  async function applyDraft() {
    if (!request || !draft || draft.errors.length || validationErrors.length) return;
    setError("");
    setNotice("");
    const next = new AbortController();
    controller.current = next;
    setPending("apply");
    try {
      if (draft.source === "Intel OpenVINO GenAI" || edited) {
        await validateSearch(request, next.signal);
      }
      if (next.signal.aborted) return;
      onApply(request);
      setDraft(null);
      setEdited(null);
      setNotice("Draft applied to the mission form. Review the mission to run the search.");
    } catch (reason) {
      if (!next.signal.aborted) setError(reason instanceof Error ? reason.message : "The draft could not be validated.");
    } finally {
      if (!next.signal.aborted) setPending(null);
    }
  }

  function editRequest(next: SearchRequest) {
    setEdited(next);
    setError("");
  }

  return (
    <details className="mission-brief" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>
        <span>
          <Icon name="compass" size={18} />
          <span>
            <strong>Start with a mission brief</strong>
            <small>Describe dates, a region, constraints, or priorities.</small>
          </span>
        </span>
      </summary>
      <div className="brief-body">
        <label className="sr-only" htmlFor={inputId}>Describe your mission</label>
        <textarea
          id={inputId}
          rows={3}
          maxLength={1000}
          placeholder={examples[0][1]}
          value={text}
          onChange={event => updateText(event.target.value)}
        />
        <div className="brief-actions">
          <span className="field-hint">
            {available === null ? "Checking OpenVINO availability…" : available
              ? "Intel OpenVINO GenAI runs on this server."
              : "OpenVINO is unavailable on this server. You can still draft with the phrase parser."}
          </span>
          <div className="copilot-actions">
            {available && <button type="button" className="primary-button" disabled={!text.trim() || pending !== null} onClick={() => void createDraft(true)}>
              Draft with OpenVINO
            </button>}
            <button type="button" className="secondary-button" disabled={!text.trim() || pending !== null} onClick={() => void createDraft(false)}>
              Draft with phrase parser
            </button>
          </div>
        </div>
        <div className="brief-examples">
          <span>Try a brief</span>
          {examples.map(([label, example]) => (
            <button type="button" key={label} onClick={() => updateText(example)}>{label}</button>
          ))}
        </div>
        {pending === "draft" && <p className="field-hint" role="status">Drafting with OpenVINO…</p>}
        {notice && <p className="success-note" role="status">{notice}</p>}
        {draft && request && (
          <section className="brief-review" aria-label="Review mission draft">
            <h3>Review before applying</h3>
            <p className="field-hint">{draft.source}</p>
            {(draft.errors.length > 0 || validationErrors.length > 0) && (
              <div className="error-box" role="alert">
                {[...new Set([...draft.errors, ...validationErrors])].map(message => <p key={message}>{message}</p>)}
              </div>
            )}
            {draft.changes.length > 0 && (
            <ul aria-label="Draft suggestions">
                {draft.changes.map(change => <li key={change}>{change}</li>)}
              </ul>
            )}
            {draft.assumptions.length > 0 && (
              <details className="copilot-draft-assumptions">
                <summary>Draft assumptions</summary>
                <ul>{[...new Set(draft.assumptions)].map(assumption => <li key={assumption}>{assumption}</li>)}</ul>
              </details>
            )}
            {draft.errors.length > 0 && <p className="field-hint">Revise the brief and draft again to resolve these issues.</p>}
            <fieldset disabled={pending === "apply" || draft.errors.length > 0} className="copilot-draft-fields">
              <legend className="sr-only">Edit proposed mission settings</legend>
              <MissionDateFields request={request} catalog={catalog} onChange={editRequest} />
              <DraftAreaFields request={request} originalArea={value.region} catalog={catalog} features={features} onChange={editRequest} />
              <p className="priority-readout">Draft priorities: {Object.entries(normalizePreferences(request.preferences)).map(([key, weight]) =>
                `${Math.round(weight * 100)}% ${key.replaceAll("_", " ").replace("terrain safety", "terrain suitability")}`
              ).join(" · ")}.</p>
              <details className="advanced-mission">
                <summary>Review limits and ranking weights</summary>
                <MissionRequirementFields request={request} catalog={catalog} features={features} onChange={editRequest} />
              </details>
            </fieldset>
            <button type="button" className="primary-button" disabled={pending !== null || draft.errors.length > 0 || validationErrors.length > 0}
              onClick={() => void applyDraft()}>
              {pending === "apply" ? "Validating draft…" : "Apply to mission form"}
              <Icon name="check" size={14} />
            </button>
          </section>
        )}
        {error && <p className="error-box" role="alert">{error}</p>}
      </div>
    </details>
  );
}

function DraftAreaFields({ request, originalArea, catalog, features, onChange }: {
  request: SearchRequest;
  originalArea: SearchRequest["region"];
  catalog: CoverageCatalog;
  features: LunarFeature[];
  onChange: (request: SearchRequest) => void;
}) {
  const region = request.region;
  const landmarks = features.filter(feature => feature.approved && feature.latitude_deg <= -87);
  const selected = region.resolved_feature_id ?? region.selector_type;
  const selectedMissing = region.selector_type === "feature_radius" && !landmarks.some(feature => feature.id === selected);
  const areaOption = originalArea.resolved_feature_id ?? originalArea.selector_type;

  function changeArea(option: string) {
    if (option === areaOption) {
      onChange({ ...request, region: originalArea });
      return;
    }
    if (option === "full_supported_region") {
      onChange({ ...request, region: { selector_type: "full_supported_region" } });
      return;
    }
    const feature = landmarks.find(landmark => landmark.id === option);
    if (!feature) return;
    onChange({ ...request, region: {
      selector_type: "feature_radius", input_text: feature.name, resolved_feature_id: feature.id,
      center: { latitude_deg: feature.latitude_deg, longitude_deg_east: feature.longitude_deg_east },
      search_radius_km: region.search_radius_km ?? Math.min(3, catalog.public_limits.maximum_radius_km),
    } });
  }

  return (
    <div className="guide-fields">
      <label className="field">
        Study area
        <select value={selected} onChange={event => changeArea(event.target.value)}>
          {originalArea.selector_type === "circle" && <option value="circle">{areaName(originalArea)}</option>}
          <option value="full_supported_region">Full prepared region</option>
          {selectedMissing && <option value={selected}>{region.input_text ?? selected}</option>}
          {landmarks.map(feature => <option key={feature.id} value={feature.id}>{feature.name}</option>)}
        </select>
      </label>
      {region.selector_type !== "full_supported_region" && <label className="field">
        Search radius (km)
        <input type="number" min={1} max={catalog.public_limits.maximum_radius_km} step="any"
          value={region.search_radius_km ?? ""} onChange={event => {
            const radius = event.target.value === "" ? undefined : event.target.valueAsNumber;
            onChange({ ...request, region: { ...region, search_radius_km: radius } });
          }} />
      </label>}
    </div>
  );
}
