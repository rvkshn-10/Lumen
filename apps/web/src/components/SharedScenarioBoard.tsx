import { useEffect, useState } from "react";
import type { Scenario, ScenarioLink } from "../lib/scenarios";
import { loadScenario } from "../lib/scenarios";
import { ScenarioBoard } from "./ScenarioBoard";
import type { TerrainData } from "../lib/types";

export function SharedScenarioBoard({ links, onClose, terrain }: { links: ScenarioLink[]; onClose: () => void; terrain?: TerrainData | null }) {
  const [outcome, setOutcome] = useState<{ rows: Scenario[]; failures: number }>();
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
  return <section className="guide-stage">
    <div className="guide-actions"><button className="secondary-button" onClick={onClose}>Back to planner</button></div>
    {!outcome ? <p role="status">Loading shared scenarios…</p> : <>
      {outcome.failures > 0 && <p role="status">{outcome.failures} shared scenarios could not be analyzed.</p>}
      {outcome.rows.length > 0 && <ScenarioBoard initialRows={outcome.rows} audience="Public" terrain={terrain} />}
    </>}
  </section>;
}
