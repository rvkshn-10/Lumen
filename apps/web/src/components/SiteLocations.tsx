import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import type { SceneSite } from "../lib/scene-geometry";
import type { SearchRequest } from "../lib/types";
import { coordinateLabel } from "../lib/hemisphere";
import { projectPolar } from "../lib/coverage";
import { siteFrame, useLocalTerrain } from "../lib/local-terrain";
import type { Candidate, MapCandidate } from "../lib/types";

const GlobeScene = lazy(() => import("./GlobeScene").then(module => ({ default: module.GlobeScene })));
const TerrainScene = lazy(() => import("./TerrainScene").then(module => ({ default: module.TerrainScene })));
const toLocal = (site: SceneSite) => {
  const [x_m, y_m] = projectPolar(site.latitude_deg, site.longitude_deg_east);
  return { ...site, x_m, y_m };
};
export function SiteLocations({ sites, eligible, eligibleTotal, dates, onClose, onInspect, coarse = false, onToggleCompare, compared, comparisonFull }: {
  sites: SceneSite[]; eligible?: SceneSite[]; eligibleTotal?: number; dates: SearchRequest["time_range"];
  onClose: () => void; onInspect?: (id: string) => void; coarse?: boolean;
  onToggleCompare?: (id: string) => void | Promise<string | undefined>;
  compared?: ReadonlyMap<string, string>; comparisonFull?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null), title = useId();
  const [all, setAll] = useState(false), [selected, setSelected] = useState(sites[0]?.id ?? eligible?.[0]?.id ?? "");
  const shown = useMemo(() => all && eligible?.length ? eligible : sites, [all, eligible, sites]);
  const chosen = shown.find(site => site.id === selected) ?? shown[0];
  const slot = chosen && compared?.get(chosen.id);
  const [comparing, setComparing] = useState(false);
  // Sites in the polar cap get NASA LOLA 80 m terrain; the whole-Moon mesh is ~7.5 km per cell.
  const polar = sites.length > 0 && [...sites, ...(eligible ?? [])].every(site => site.latitude_deg <= -86.9);
  const [view, setView] = useState<"terrain" | "moon">(polar ? "terrain" : "moon");
  const localSites = useMemo(() => polar ? sites.map(toLocal) : [], [polar, sites]);
  const localPoints = useMemo(() => polar ? (eligible ?? []).map(toLocal) : [], [polar, eligible]);
  const frame = useMemo(() => polar ? siteFrame(all && localPoints.length ? localPoints : localSites, 3) : null, [polar, all, localPoints, localSites]);
  const terrain = useLocalTerrain(view === "terrain" ? frame : null, null);
  const [compareError, setCompareError] = useState<{ id: string; message: string }>();
  async function toggleCompare(id: string) {
    setComparing(true);
    setCompareError(undefined);
    try {
      const message = await onToggleCompare?.(id);
      if (message && typeof message === "string") setCompareError({ id, message });
    } finally { setComparing(false); }
  }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current; element?.showModal();
    return () => { element?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={dialog} className="planning-dialog site-locations-dialog" aria-labelledby={title} onCancel={onClose}>
    <div className="planning-dialog-header"><h2 id={title}>{coarse ? "Explore the ranked local area" : "Places to consider · 3D Moon"}</h2><button className="secondary-button" autoFocus onClick={onClose}>Close site map</button></div>
    {eligible && eligible.length > 0 && <div className="guide-actions" role="group" aria-label="Mapped site set"><button className="secondary-button" aria-pressed={!all} onClick={() => setAll(false)}>Shortlist ({sites.length})</button><button className="secondary-button" aria-pressed={all} onClick={() => setAll(true)}>Eligible locations ({eligible.length})</button></div>}
    <p className="mapped-site-count">Showing {shown.length.toLocaleString()} locations. Gold: ranked candidates · green: other eligible locations · white: selected.</p>
    {all && eligibleTotal != null && eligibleTotal > (eligible?.length ?? 0) && <p className="field-hint">The service returned a spatial sample of {eligible!.length.toLocaleString()} of {eligibleTotal.toLocaleString()} eligible locations. The ranking evaluated every eligible location; this map does not show omitted points.</p>}
    {coarse && <p className="changed-notice">Exploratory coarse ranking · 2 km candidate spacing · sunlight and Earth visibility only. No fine terrain or mission hard-constraint screening.</p>}
    {polar && <div className="guide-actions" role="group" aria-label="Map view">
      <button className="secondary-button" aria-pressed={view === "terrain"} onClick={() => setView("terrain")}>Local terrain · 80 m</button>
      <button className="secondary-button" aria-pressed={view === "moon"} onClick={() => setView("moon")}>Moon context</button>
    </div>}
    {chosen && <><div className="candidate-globe"><Suspense fallback={<p role="status">Loading site locations…</p>}>{view === "terrain" && polar
      ? terrain ? <TerrainScene terrain={terrain} candidates={localSites as unknown as Candidate[]} selected={chosen.id} onSelect={setSelected}
        mode="terrain" layer={all ? "score" : "terrain"} mapCandidates={localPoints as unknown as MapCandidate[]} psr={null} features={[]} />
        : <p role="status">Loading NASA LOLA terrain around these sites…</p>
      : <GlobeScene sites={shown} selectedSite={chosen.id} onSiteSelect={setSelected} selectedCenter={chosen} timeRange={dates} preparedLabel={coarse ? "Coarse global terrain" : "Applied prepared-site analysis"} />}</Suspense></div>
      <div className="mapped-site-detail">
        <strong>{chosen.rank ? `Candidate ${chosen.rank}` : "Eligible location"} · {coordinateLabel(chosen)}</strong>
        <span>Planning score {chosen.score.toFixed(1)} / 100{chosen.illumination_fraction != null ? ` · Sun ${(chosen.illumination_fraction * 100).toFixed(1)}%` : ""}{chosen.earth_visibility_fraction != null ? ` · Earth ${(chosen.earth_visibility_fraction * 100).toFixed(1)}%` : ""}</span>
        {onToggleCompare && <button type="button" className="primary-button" disabled={comparing || (comparisonFull && !slot)}
          onClick={() => void toggleCompare(chosen.id)}>{slot ? `Remove ${slot} from comparison` : "Add mapped site to comparison"}</button>}
        {onInspect && <button className="secondary-button" onClick={() => { onClose(); onInspect(chosen.id); }}>Inspect mapped site</button>}
      </div>
      {comparing && <p role="status">Analyzing the mapped site…</p>}
      {compareError?.id === chosen.id && <p role="alert" className="guide-error">{compareError.message}</p>}
      {onToggleCompare && comparisonFull && !slot && <p className="field-hint">Remove a site from Compare to make room.</p>}
    </>}
    <label className="field">Select a mapped location<select aria-label="Select mapped location" value={chosen?.id ?? ""} onChange={event => setSelected(event.target.value)}>{shown.map(site => <option value={site.id} key={site.id}>{site.rank ? `#${site.rank}` : site.id} · {coordinateLabel(site)} · score {site.score.toFixed(1)}</option>)}</select></label>
    {view === "terrain" && polar ? <p className="field-hint">NASA LOLA LDEM_80S 80 m/px terrain in polar stereographic, height 1.5×. Numbered rings are ranked sites; dots are other eligible locations coloured by planning score.</p> : <p className="field-hint">Frame all sites returns to the local cluster. Fit view shows the whole Moon. Markers are raised above the display terrain for visibility; scores use the applied search data.</p>}
  </dialog>;
}
