import { useEffect, useRef, useState } from "react";
import type { Scenario, ScenarioLink } from "../lib/scenarios";
import { loadScenario } from "../lib/scenarios";
import { ScenarioBoard } from "./ScenarioBoard";

export function SharedScenarioBoard({ links, onClose, demo = false }: { links: ScenarioLink[]; onClose: () => void; demo?: boolean }) {
  const [outcome, setOutcome] = useState<{ rows: Scenario[]; failures: number }>();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    async function restore() {
      const rows: Scenario[] = [];
      let failures = 0;
      for (const link of links) {
        if (controller.signal.aborted) return;
        try {
          const row = await loadScenario(link.id, link.request, controller.signal);
          if (!rows.some(item => item.key === row.key)) rows.push({ ...row, label: link.label });
        } catch { failures++; }
      }
      if (!controller.signal.aborted) setOutcome({ rows, failures });
    }
    void restore();
    return () => controller.abort();
  }, [links]);
  const [first, second] = outcome?.rows ?? [];
  const extraEarthHours = first && second &&
    first.site.metrics.longest_communication_hours - second.site.metrics.longest_communication_hours;
  return <section className="guide-stage">
    <h1 tabIndex={-1} ref={heading}>{demo ? "Two sites, one week on the Moon" : "Shared scenario board"}</h1>
    {demo && <p>October 5–12, 2028 UTC · Compare sunlight and the time Earth stays above the local terrain horizon.</p>}
    {demo && typeof extraEarthHours === "number" && extraEarthHours > 0 &&
      <p>Site A has {extraEarthHours.toFixed(1)} more continuous hours with Earth in view than Site B.</p>}
    <div className="guide-actions"><button className="secondary-button" onClick={onClose}>Back to planner</button></div>
    {!outcome ? <p role="status">Loading site analyses…</p> : <>
      {outcome.failures > 0 && <p role="status">{outcome.failures} shared scenarios could not be analyzed.</p>}
      {outcome.rows.length > 0 && <ScenarioBoard initialRows={outcome.rows} selectInitialRows={demo} audience="Public" />}
    </>}
  </section>;
}
