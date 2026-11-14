import { useMemo, useState } from "react";
import type { SearchResponse } from "../lib/types";
import { coordinate, percent } from "../lib/format";
import { SiteLocations } from "./SiteLocations";
import type { SceneSite } from "../lib/scene-geometry";
import { siteTakeaway } from "../lib/planning";

export function CandidateResults({ result, selected, onSelect }: {
  result: SearchResponse; selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false), [mapOpen, setMapOpen] = useState(false);
  const sites = useMemo(() => result.candidates.map(site => ({ ...site, illumination_fraction: site.metrics.illumination_fraction, earth_visibility_fraction: site.metrics.earth_visibility_fraction })), [result]);
  const eligible = useMemo(() => (result.map_candidates ?? []).flatMap(point => {
    if (point.latitude_deg == null || point.longitude_deg_east == null) return [];
    return [{ ...point, latitude_deg: point.latitude_deg, longitude_deg_east: point.longitude_deg_east, rank: result.candidates.find(site => site.id === point.id)?.rank } satisfies SceneSite];
  }), [result]);
  const selectedSite = result.candidates.find(site => site.id === selected);
  const explanation = selectedSite ? siteTakeaway(selectedSite, result) : null;
  return <section className="results-section" aria-labelledby="results-title">
    <div className="section-heading"><div><span className="eyebrow">03 / REVIEW THE TRADEOFFS</span><h2 id="results-title">A few places to consider.</h2></div></div>
    <p className="results-summary">{result.counts.temporal_pass.toLocaleString()} eligible of {result.counts.region.toLocaleString()} prepared locations. Scores less than 2 points apart are near ties under these priorities.</p>
    {(sites.length > 0 || eligible.length > 0) && <button className="primary-button" onClick={() => setMapOpen(true)}>View sites on 3D Moon</button>}
    {mapOpen && <SiteLocations sites={sites} eligible={eligible} eligibleTotal={result.counts.temporal_pass} dates={result.request.time_range} onClose={() => setMapOpen(false)} onInspect={onSelect} />}
    {!result.candidates.length ? <div className="empty-results" role="status"><h3>No sites meet these requirements.</h3><p>{result.empty_reason}</p><p>{result.counts.region} in the area → {result.counts.terrain_pass} pass terrain/proximity limits → {result.counts.temporal_pass} pass mission-time limits.</p><p>Your limits have not been relaxed. Go back to edit your mission.</p></div> : <>
      <div className="candidate-grid">{result.candidates.slice(0, expanded ? undefined : 3).map(site => <article className={`candidate-card ${selected === site.id ? "selected" : ""}`} key={site.id}>
        <div className="compact-candidate-content"><span className="eyebrow">Candidate {String(site.rank).padStart(2, "0")}</span><h3>{coordinate(site.latitude_deg, site.longitude_deg_east)}</h3>
          <dl className="primary-metrics"><div><dt>Time with sunlight</dt><dd>{percent(site.metrics.illumination_fraction)}</dd></div><div><dt>Time with Earth in view</dt><dd>{percent(site.metrics.earth_visibility_fraction)}</dd></div><div><dt>Terrain slope</dt><dd>{site.slope_deg.toFixed(1)}°</dd></div></dl>
          <button className="secondary-button" onClick={() => onSelect(site.id)}>Inspect site {String(site.rank).padStart(2, "0")}</button></div>
      </article>)}</div>
      {result.candidates.length > 3 && <button className="text-button reveal-candidates" onClick={() => setExpanded(value => !value)}>{expanded ? "Show three initial sites" : `Reveal ${result.candidates.length - 3} more candidates`}</button>}
      {explanation && <aside className="site-takeaway"><h3>Why consider Candidate {selectedSite!.rank}?</h3><p>{explanation.reason}</p><p>{explanation.tradeoff}</p><p className="field-hint">This compares your mission priorities. It does not establish landing safety or RF performance.</p></aside>}
    </>}
    <p className="field-hint">Sunlight counts any visible upper solar limb. Earth view means the center of Earth is above the modeled terrain horizon. Percentages are sampled mission time, not certainty.</p>
    <details className="selection-funnel"><summary>How the shortlist was selected</summary><p>{result.counts.region.toLocaleString()} prepared locations → {result.counts.terrain_pass.toLocaleString()} pass terrain/proximity → {result.counts.temporal_pass.toLocaleString()} pass mission-time limits → {result.counts.shortlisted} spatially separated sites. Nearby unlisted locations can also be eligible.</p></details>
  </section>;
}
