import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { SearchResponse } from "../lib/types";
import { coordinate, hours, percent } from "../lib/format";
import { COMPARE_LIMIT, compareSiteLetter } from "../lib/compare-sites";
import { COMPARE_COLORS } from "../lib/sky-geometry";
import "./leaderboard.css";

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Ranked sites, filled in row by row as the analysis lands. Selecting rows
 * builds the comparison; the order of selection sets the A–D slots.
 */
export function Leaderboard({ result, pending, statusText, regionCount, selected, onToggle, onCompare, onDetails }: {
  result: SearchResponse | null;
  pending: boolean;
  statusText?: string;
  regionCount?: number;
  selected: string[];
  onToggle: (id: string) => void;
  onCompare: () => void;
  onDetails?: (id: string) => void;
}) {
  const ranked = useMemo(() => result ? [...result.candidates].sort((a, b) => a.rank - b.rank) : [], [result]);
  const [revealed, setRevealed] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!result) { setRevealed(0); return; }
    if (reducedMotion()) { setRevealed(ranked.length); return; }
    setRevealed(0);
    let count = 0;
    const timer = setInterval(() => {
      count += 1; setRevealed(count);
      if (count >= ranked.length) clearInterval(timer);
    }, 110);
    return () => clearInterval(timer);
  }, [result?.search_id, ranked.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pending) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [pending]);

  const best = useMemo(() => ranked[0]?.score ?? 100, [ranked]);
  const shown = ranked.slice(0, revealed);
  const filling = !!result && revealed < ranked.length;
  const full = selected.length >= COMPARE_LIMIT;

  return <section className="leaderboard glass-surface" aria-labelledby="leaderboard-title" aria-busy={pending || filling}>
    <header className="leaderboard-head">
      <div>
        <h2 id="leaderboard-title">Leaderboard</h2>
        <p role="status" aria-live="polite">{pending
          ? `${statusText ?? "Ranking sites"}${regionCount ? ` · ${regionCount.toLocaleString()} prepared locations` : ""} · ${elapsed}s`
          : result ? ranked.length
            ? `${result.counts.temporal_pass.toLocaleString()} of ${result.counts.region.toLocaleString()} locations meet every limit · top ${ranked.length} shown, at least 1.5 km apart`
            : "No site meets every required limit."
          : "Choose a mission style to start ranking."}</p>
      </div>
      {(pending || filling) && <span className="leaderboard-live"><i aria-hidden="true" />Live</span>}
    </header>

    <div className="leaderboard-table" role="table" aria-label="Ranked sites">
      <div className="leaderboard-row leaderboard-columns" role="row">
        <span role="columnheader">#</span>
        <span role="columnheader">Site</span>
        <span role="columnheader">Score</span>
        <span role="columnheader">Sunlight</span>
        <span role="columnheader">Earth in view</span>
        <span role="columnheader">Longest night</span>
        <span role="columnheader">Slope</span>
        <span role="columnheader"><span className="sr-only">Compare</span></span>
      </div>
      {shown.map(site => {
        const slot = selected.indexOf(site.id);
        return <div role="row" key={site.id} className={`leaderboard-row leaderboard-site${slot >= 0 ? " picked" : ""}`}
          style={slot >= 0 ? { "--slot": COMPARE_COLORS[slot] } as CSSProperties : undefined}>
          <span role="cell" className="leaderboard-rank">{site.rank}</span>
          <span role="cell" className="leaderboard-name"><strong>Candidate {site.rank}</strong><small>{coordinate(site.latitude_deg, site.longitude_deg_east)}</small></span>
          <span role="cell" className="leaderboard-score"><b>{site.score.toFixed(1)}</b><i aria-hidden="true"><span style={{ width: `${Math.max(4, site.score / Math.max(best, 1) * 100)}%` }} /></i></span>
          <span role="cell" data-label="Sunlight">{percent(site.metrics.illumination_fraction)}</span>
          <span role="cell" data-label="Earth in view">{percent(site.metrics.earth_visibility_fraction)}</span>
          <span role="cell" data-label="Longest night">{hours(site.metrics.longest_darkness_hours)}</span>
          <span role="cell" data-label="Slope">{site.slope_deg.toFixed(1)}°</span>
          <span role="cell" className="leaderboard-actions">
            {onDetails && <button type="button" className="text-button" onClick={() => onDetails(site.id)} aria-label={`Details for candidate ${site.rank}`}>Details</button>}
            <button type="button" className="leaderboard-pick" aria-pressed={slot >= 0} disabled={full && slot < 0}
              aria-label={slot >= 0 ? `Remove candidate ${site.rank} from comparison` : `Compare candidate ${site.rank}`}
              onClick={() => onToggle(site.id)}>{slot >= 0 ? compareSiteLetter(slot) : "+"}</button>
          </span>
        </div>;
      })}
      {(pending || filling) && Array.from({ length: Math.max(0, (pending ? 6 : ranked.length) - shown.length) }, (_, index) =>
        <div role="row" aria-hidden="true" key={`ghost-${index}`} className="leaderboard-row leaderboard-ghost"><span /><span /><span /><span /><span /><span /><span /><span /></div>)}
    </div>

    {result && !ranked.length && <p className="leaderboard-empty">{result.empty_reason || "Try a different mission style, wider area or other dates."}</p>}
    {ranked.length > 0 && <footer className="leaderboard-foot">
      <p>{selected.length ? `${selected.length} of ${COMPARE_LIMIT} selected` : `Pick up to ${COMPARE_LIMIT} sites to compare`}</p>
      <button type="button" className="primary-button" disabled={!selected.length} onClick={onCompare}>
        Compare {selected.length > 1 ? `${selected.length} sites` : selected.length ? "this site" : "sites"}
      </button>
    </footer>}
  </section>;
}
