import { useEffect, useId, useRef, useState } from "react";
import { explainMissionComparison } from "../lib/api";
import type { ExplanationCandidate, ExplanationGoal } from "../lib/api";
import { useCopilotAvailability } from "./useCopilotAvailability";

export function CopilotExplanation({ candidates }: { candidates: ExplanationCandidate[] }) {
  const goalId = useId();
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState<ExplanationGoal>("balanced");
  const [explanation, setExplanation] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const available = useCopilotAvailability(open);

  useEffect(() => () => controller.current?.abort(), []);

  async function explain() {
    const next = new AbortController();
    controller.current = next;
    setExplanation("");
    setError("");
    setPending(true);
    try {
      const result = await explainMissionComparison(candidates, goal, next.signal);
      if (!next.signal.aborted) setExplanation(result.explanation);
    } catch (reason) {
      if (!next.signal.aborted) setError(reason instanceof Error ? reason.message : "The explanation is unavailable.");
    } finally {
      if (!next.signal.aborted) setPending(false);
    }
  }

  return (
    <details className="copilot-explanation" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>Explain tradeoffs with OpenVINO</summary>
      {available === null ? (
        <p className="field-hint" role="status">Checking OpenVINO availability…</p>
      ) : !available ? (
        <p className="field-hint" role="status">OpenVINO is unavailable on this server. Use the comparison table above to see each tradeoff.</p>
      ) : (
        <>
          <p className="field-hint">Intel OpenVINO GenAI chooses an emphasis using the sunlight, Earth view, and longest night values above.</p>
          <div className="copilot-actions">
            <label className="field" htmlFor={goalId}>
              Emphasize
              <select id={goalId} value={goal} disabled={pending} onChange={event => {
                setGoal(event.target.value as ExplanationGoal);
                setExplanation("");
                setError("");
              }}>
                <option value="balanced">Most distinct tradeoff</option>
                <option value="sunlight">More sunlight</option>
                <option value="earth">More Earth visibility</option>
                <option value="darkness">Shorter longest night</option>
              </select>
            </label>
            <button type="button" className="secondary-button" disabled={pending} onClick={() => void explain()}>
              Explain selected scenarios
            </button>
          </div>
          <div role="status">
            {pending && <p className="field-hint">Comparing the calculated values…</p>}
            {explanation && <p className="copilot-explanation-text">{explanation}</p>}
          </div>
          {error && <p className="error-box" role="alert">{error}</p>}
        </>
      )}
    </details>
  );
}
