import { useEffect, useRef, useState } from "react";
import type { Audience, Scenario, ScenarioLink } from "../lib/scenarios";
import { loadScenario } from "../lib/scenarios";
import { ScenarioBoard } from "./ScenarioBoard";
import type { TerrainData } from "../lib/types";

export function SharedScenarioBoard({ links, demo = false, audience = "Public", terrain }: { links: ScenarioLink[]; demo?: boolean; audience?: Audience; terrain?: TerrainData | null }) {
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
  return <section className="guide-stage compare-page">
    <header className="compare-page-header">
      <h1 tabIndex={-1} ref={heading}>Compare lunar sites</h1>
    </header>
    {!outcome ? <p role="status">Loading site analyses…</p> : <>
      {outcome.failures > 0 && <p role="status">{outcome.failures} shared scenarios could not be analyzed.</p>}
      {outcome.rows.length > 0 && <ScenarioBoard initialRows={outcome.rows} selectInitialRows={demo} audience={audience} terrain={terrain} />}
    </>}
    {demo && <details className="compare-provenance">
      <summary>Data and verification</summary>
      <p>An independent check of these two October 5–12 timelines reproduced all Sun and Earth visibility labels at 4,034 timestamps. The largest difference in a Sun or Earth angle was 7.62 × 10⁻¹¹ degrees between the two computations.</p>
      <p>The check uses the same terrain and ephemeris inputs. It tests the calculation and does not measure terrain accuracy.</p>
      <p><a href="https://pgda.gsfc.nasa.gov/products/90" target="_blank" rel="noreferrer">NASA LOLA terrain</a> · <a href="https://naif.jpl.nasa.gov/naif/data_generic.html" target="_blank" rel="noreferrer">JPL ephemerides</a> · <a href="https://github.com/rvkshn-10/Lumen/pull/2" target="_blank" rel="noreferrer">Independent verifier</a></p>
    </details>}
  </section>;
}
