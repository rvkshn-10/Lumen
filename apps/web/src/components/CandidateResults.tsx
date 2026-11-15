import { useId, useMemo, useState } from "react";
import type { SearchResponse } from "../lib/types";
import { coordinate, percent } from "../lib/format";
import type { SceneSite } from "../lib/scene-geometry";
import { Icon } from "./Icon";
import { SiteLocations } from "./SiteLocations";
import "./site-rankings.css";

export function CandidateResults({ result, onSelect, onToggleCompare, compared, comparisonFull }: {
  result: SearchResponse;
  onSelect: (id: string) => void;
  onToggleCompare: (id: string) => void | Promise<string | undefined>;
  compared: ReadonlyMap<string, string>;
  comparisonFull: boolean;
}) {
  const headingId = useId();
  const [mapOpen, setMapOpen] = useState(false);
  const ranked = useMemo(() => [...result.candidates].sort((a, b) => a.rank - b.rank), [result.candidates]);
  const rankedLocations = useMemo(() => ranked.map(site => ({
    ...site,
    illumination_fraction: site.metrics.illumination_fraction,
    earth_visibility_fraction: site.metrics.earth_visibility_fraction,
  })), [ranked]);
  const eligible = useMemo(() => {
    const ranks = new Map(ranked.map(site => [site.id, site.rank]));
    return (result.map_candidates ?? []).flatMap(point =>
      point.latitude_deg == null || point.longitude_deg_east == null
        ? []
        : [{ ...point, latitude_deg: point.latitude_deg, longitude_deg_east: point.longitude_deg_east, rank: ranks.get(point.id) } satisfies SceneSite]);
  }, [ranked, result.map_candidates]);

  return (
    <section className="site-rankings" aria-labelledby={headingId}>
      <header className="site-rankings-header">
        <div>
          <h2 id={headingId}>Site rankings</h2>
          {ranked.length > 0 && <p>Scores reflect your mission priorities. Sites within 2 points are near ties.</p>}
        </div>
        {(ranked.length > 0 || eligible.length > 0) && (
          <button type="button" className="secondary-button" onClick={() => setMapOpen(true)}>View sites on 3D Moon</button>
        )}
      </header>
      {mapOpen && (
        <SiteLocations sites={rankedLocations} eligible={eligible} eligibleTotal={result.counts.temporal_pass}
          dates={result.request.time_range} onClose={() => setMapOpen(false)} onInspect={onSelect}
          onToggleCompare={onToggleCompare} compared={compared} comparisonFull={comparisonFull} />
      )}
      {ranked.length > 0 ? (
        <ol className="site-rankings-list" role="list">
          {ranked.map(site => {
            const slot = compared.get(site.id);
            return (
              <li className="site-rankings-row" key={site.id}>
                <div className="site-rankings-name">
                  <h3>Candidate {site.rank}</h3>
                  <p>{coordinate(site.latitude_deg, site.longitude_deg_east)}</p>
                </div>
                <dl className="site-rankings-metrics">
                  <div><dt>Score</dt><dd><strong>{site.score.toFixed(1)}</strong><span> / 100</span></dd></div>
                  <div><dt>Sunlight</dt><dd>{percent(site.metrics.illumination_fraction)}</dd></div>
                  <div><dt>Earth in view</dt><dd>{percent(site.metrics.earth_visibility_fraction)}</dd></div>
                  <div><dt>Slope</dt><dd>{site.slope_deg.toFixed(1)}°</dd></div>
                </dl>
                <div className="site-rankings-actions">
                  <button type="button" className="text-button" aria-label={`Inspect site ${String(site.rank).padStart(2, "0")}`}
                    onClick={() => onSelect(site.id)}>Inspect</button>
                  <button type="button" className="secondary-button site-rankings-compare"
                    aria-label={slot ? `Remove candidate ${site.rank} from comparison (${slot})` : `Add candidate ${site.rank} to comparison`}
                    disabled={comparisonFull && !slot} onClick={() => { void onToggleCompare(site.id); }}>
                    {slot ? <>{slot} <Icon name="close" size={14} /></> : "Add to comparison"}
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="site-rankings-empty">
          <h3>No sites meet these requirements</h3>
          <p>{result.empty_reason || "Edit the area, mission dates or required limits to try again."}</p>
        </div>
      )}
      <details className="selection-funnel site-rankings-details">
        <summary>How sites are ranked</summary>
        <p>
          Of {result.counts.region.toLocaleString()} prepared locations, {result.counts.terrain_pass.toLocaleString()} pass terrain and proximity limits
          and {result.counts.temporal_pass.toLocaleString()} pass all mission limits. The ranking shows {result.counts.shortlisted.toLocaleString()} spatially
          separated candidates. Nearby locations can also qualify.
        </p>
        <p>Sunlight measures sampled time with any part of the Sun visible. Earth in view measures sampled time when Earth's center clears the modeled terrain horizon.</p>
      </details>
    </section>
  );
}
