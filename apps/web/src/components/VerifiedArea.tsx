import { lazy, Suspense, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { LunarFeature, SearchRequest, TerrainData } from "../lib/types";
import type { CoverageCatalog, CoverageOutcome } from "../lib/planning";
import { projectPolar, selectedCircle } from "../lib/coverage";
import { HemisphereDiscovery } from "./HemisphereDiscovery";
import { CoarseAreaPreview } from "./CoarseAreaPreview";
import { southernCoordinate } from "../lib/hemisphere";
import { coordinate } from "../lib/format";
import "./hemisphere.css";

const GlobeScene = lazy(() => import("./GlobeScene").then(module => ({ default: module.GlobeScene })));

export function VerifiedArea({ catalog, request, features, outcome, pending, error, onChange, onRetry, actions }: {
  /** Kept for callers; the area step now uses the 3D Moon only. */
  terrain?: TerrainData | null;
  catalog: CoverageCatalog; request: SearchRequest; features: LunarFeature[];
  outcome: CoverageOutcome | null; pending: boolean; error: string | null;
  onChange: (request: SearchRequest) => void; onRetry: () => void; actions: ReactNode;
}) {
  const [local, setLocal] = useState(false);
  const localRegion = useRef<SearchRequest["region"]>({ selector_type: "circle", center: { latitude_deg: -89.9, longitude_deg_east: 0 }, search_radius_km: 3 });
  if (request.region.selector_type !== "southern_hemisphere" && request.region.selector_type !== "full_supported_region") localRegion.current = structuredClone(request.region);
  const wholeSurvey = request.region.selector_type === "southern_hemisphere";
  const fullRegion = request.region.selector_type === "full_supported_region";
  function chooseScope(scope: "local" | "southern_hemisphere" | "full_supported_region") {
    setSelectionError("");
    onChange({ ...request, region: scope === "local" ? structuredClone(localRegion.current) : { selector_type: scope } });
  }
  const [selectionError, setSelectionError] = useState("");
  const circle = selectedCircle(request.region, features);
  const selectedFeature = request.region.selector_type === "feature_radius" ? features.find(feature => feature.id === request.region.resolved_feature_id) : undefined;
  const center = selectedFeature ? { latitude_deg: selectedFeature.latitude_deg, longitude_deg_east: selectedFeature.longitude_deg_east } : request.region.center ?? { latitude_deg: -89.9, longitude_deg_east: 0 };
  // While a new area is being checked, keep showing the last result's layout
  // (feedback row, preview panel) so the page doesn't collapse and re-expand.
  const lastOutcome = useRef<CoverageOutcome | null>(outcome);
  if (outcome) lastOutcome.current = outcome;
  const shownOutcome = outcome ?? (pending ? lastOutcome.current : null);
  const coverageSummary = pending ? "Checking coverage…"
    : error ? "Coverage unavailable"
    : outcome?.status === "outside" ? "Outside detailed coverage"
    : outcome?.status === "partial" ? `${outcome.candidate_count.toLocaleString()} prepared sites in the covered portion`
    : outcome ? wholeSurvey ? `${outcome.candidate_count.toLocaleString()} regional survey locations · whole southern hemisphere` : `${outcome.candidate_count.toLocaleString()} prepared sites`
    : "Choose an area";
  const landmarks = features.filter(feature => {
    if (catalog.hemisphere_detailed) return feature.latitude_deg <= 0;
    if (feature.latitude_deg > -87) return false;
    const [x, y] = projectPolar(feature.latitude_deg, feature.longitude_deg_east);
    const [left, bottom, right, top] = catalog.geometry.extent_m;
    const radius = (request.region.search_radius_km ?? 3) * 1000;
    return x + radius >= left && x - radius <= right && y + radius >= bottom && y - radius <= top;
  });
  function selectCoordinate(coordinate: { latitude_deg: number; longitude_deg_east: number }) {
    if (!southernCoordinate(coordinate)) { setSelectionError("Choose a point in the southern hemisphere, between the equator and the south pole."); return; }
    setSelectionError(""); setLocal(true);
    onChange({ ...request, region: { selector_type: "circle", center: { latitude_deg: coordinate.latitude_deg, longitude_deg_east: coordinate.longitude_deg_east }, search_radius_km: request.region.search_radius_km ?? 3 } });
  }
  function selectArea(coordinate: { latitude_deg: number; longitude_deg_east: number }, radiusKm: number) {
    if (!southernCoordinate(coordinate)) { setSelectionError("Choose an area in the southern hemisphere."); return; }
    setSelectionError(""); setLocal(true);
    onChange({ ...request, region: { selector_type: "circle", center: coordinate, search_radius_km: radiusKm } });
  }
  return <>
  {selectionError && <p className="guide-error" role="alert">{selectionError}</p>}
    <div className="area-scope-picker" role="group" aria-label="Search scope">
      <button type="button" aria-pressed={wholeSurvey} disabled={!catalog.hemisphere_survey} onClick={() => chooseScope("southern_hemisphere")}><strong>Survey the hemisphere</strong><span>{catalog.hemisphere_survey ? "827 regional locations · about 150 km apart" : "Survey data unavailable on this service"}</span></button>
      <button type="button" aria-pressed={!wholeSurvey && !fullRegion} onClick={() => chooseScope("local")}><strong>Search a local area</strong><span>Detailed terrain · up to {catalog.public_limits.maximum_radius_km} km radius</span></button>
      <button type="button" aria-pressed={fullRegion} onClick={() => chooseScope("full_supported_region")}><strong>Compare the polar cap</strong><span>Prepared October 2028 window</span></button>
    </div>
  {(wholeSurvey || fullRegion) && <p className="area-scope-explanation field-hint">{wholeSurvey ? "Ranks regional locations across the entire south using coarse horizons. Refine shortlisted areas with detailed local terrain." : "Compare prepared polar sites over the fixed October 2028 window."}</p>}
  <div className="area-layout">
    <div className="area-setup">
    {!wholeSurvey && !fullRegion && <details className="area-editor" open>
      <summary>Study area<span>{request.region.selector_type === "full_supported_region" ? "Full prepared region" : coordinate(center.latitude_deg, center.longitude_deg_east)}</span></summary>
      <div className="area-editor-content">
      <label className="field">Area selection<select aria-label="Area selection" value={request.region.selector_type} onChange={event => {
        const mode = event.target.value as SearchRequest["region"]["selector_type"];
        if (mode === "full_supported_region" || mode === "southern_hemisphere") chooseScope(mode);
        else if (mode === "feature_radius") {
          const feature = landmarks[0];
          onChange({ ...request, region: { selector_type: mode, resolved_feature_id: feature?.id, input_text: feature?.name,
            center: feature ? { latitude_deg: feature.latitude_deg, longitude_deg_east: feature.longitude_deg_east } : undefined, search_radius_km: request.region.search_radius_km ?? 3 } });
        } else onChange({ ...request, region: { selector_type: mode, center, search_radius_km: request.region.search_radius_km ?? 3 } });
      }}><option value="circle">Local area · coordinates or map</option><option value="feature_radius" disabled={!landmarks.length}>Near an approved landmark{!landmarks.length ? " · no supported landmarks" : ""}</option><option value="full_supported_region">Full prepared region · October 2028 demo</option></select></label>
      {request.region.selector_type === "feature_radius" && <label className="field">Approved landmark<select value={request.region.resolved_feature_id ?? ""} onChange={event => {
        const feature = features.find(item => item.id === event.target.value)!;
        onChange({ ...request, region: { ...request.region, resolved_feature_id: feature.id, input_text: feature.name, center: { latitude_deg: feature.latitude_deg, longitude_deg_east: feature.longitude_deg_east } } });
      }}>{features.map(feature => <option key={feature.id} value={feature.id} disabled={!landmarks.some(item => item.id === feature.id)}>{feature.name}{!landmarks.some(item => item.id === feature.id) ? " · outside coverage" : ""}</option>)}</select></label>}
      {request.region.selector_type === "circle" && <div className="guide-fields"><label className="field">Latitude °S (negative)<input type="number" min="-90" max="0" step="any" value={Number(center.latitude_deg.toFixed(6))} onChange={event => selectCoordinate({ ...center, latitude_deg: Number(event.target.value) })} /></label>
        <label className="field">Longitude °E<input type="number" min="-180" max="179.999999" step="any" value={Number(center.longitude_deg_east.toFixed(6))} onChange={event => selectCoordinate({ ...center, longitude_deg_east: Number(event.target.value) })} /></label></div>}
      {request.region.selector_type !== "full_supported_region" && <label className="field">Search radius (km)<input type="number" min="1" max={catalog.public_limits.maximum_radius_km} step=".01" value={request.region.search_radius_km ?? ""} onChange={event => onChange({ ...request, region: { ...request.region, search_radius_km: event.target.value ? Number(event.target.value) : undefined } })} /></label>}
      {catalog.public_limits.maximum_radius_km > 5 && <p className="field-hint">Areas above 5 km are experimental and may take longer. The seven-day mission limit still applies.</p>}
      <HemisphereDiscovery features={features} center={center} local={local} onExplore={() => setLocal(false)} onSelect={selectCoordinate} />
      <details className="area-coverage-details"><summary>Coverage details</summary>
        <p>Prepared sites are spaced {catalog.candidate_spacing_m} m apart. The grid excludes the exact pole.</p>
        <p>Local detailed searches cover up to {catalog.public_limits.maximum_radius_km} km radius. Use the full-region demo to compare across the dataset.</p>
      </details>
      </div>
    </details>}
    <div className="area-next">
      <p className={`area-coverage-status${!pending && shownOutcome?.status === "outside" ? " sr-only" : ""}`} role="status" aria-busy={pending}>{coverageSummary}</p>
      <div className="area-sidebar-actions">{actions}</div>
      {/* Sits where "Continue" was, so the panel keeps its height when an area is outside coverage. */}
      {shownOutcome?.status === "outside" && southernCoordinate(center) && <div className="area-outside-actions" aria-hidden={pending || undefined}>
        <a className="text-button" href="#area-preview">Preview this area</a>
      </div>}
    </div>
    {error && <div className="area-feedback"><p>{error}</p><button className="secondary-button" onClick={onRetry}>Retry coverage check</button></div>}
    </div>
    <div className="area-scene">
      <div className="area-3d-preview">
        <Suspense fallback={<p role="status">Loading the 3D Moon…</p>}>
          <GlobeScene onArea={selectArea} maximumRadiusKm={catalog.public_limits.maximum_radius_km}
            preparedLabel={wholeSurvey ? "Southern hemisphere regional survey" : catalog.hemisphere_detailed ? "Southern hemisphere detailed local terrain" : catalog.label} selectedCenter={circle ? center : undefined} focusSelection={local}
            radiusKm={request.region.search_radius_km} timeRange={request.time_range} onPick={selectCoordinate} />
        </Suspense>
      </div>
    </div>
  </div>
  {!fullRegion && !wholeSurvey && <div id="area-preview" className="local-area-workspace" hidden={shownOutcome?.status !== "outside" || !southernCoordinate(center)}><CoarseAreaPreview center={center} radiusKm={request.region.search_radius_km} /></div>}
  </>;
}
