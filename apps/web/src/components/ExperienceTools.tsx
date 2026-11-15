import { useEffect, useRef, useState } from "react";
import type { Audience } from "../lib/scenarios";
import type { Appearance } from "../lib/appearance";
import { getCuratedSites } from "../lib/experience-api";
import type { CuratedSite } from "../lib/experience-api";
import { clpsMissions } from "../data/clps-missions";
import { ClpsMissionDetails, MissionReplay } from "./MissionReplay";
import { PlanningDialog } from "./PlanningEvidence";
import { Icon } from "./Icon";
import { CONNECTING_RIDGE_ID, CraterInspection } from "./CraterInspection";
import type { LunarFeature } from "../lib/types";

const tour = [
  ["Choose an area", "Pick the center of your search on the Moon or enter its coordinates. Detailed comparisons use the prepared south-pole region."],
  ["Set the mission", "Choose your dates and priorities, then click Find candidate sites."],
  ["Compare sites", "Choose a site for each slot at the top. Add sites from the ranked shortlist or the map below."],
];
export function ExperienceTools({ appearance, onAppearance, audience, onAudience, candidateCount }: {
  appearance: Appearance; onAppearance: (value: Appearance) => void;
  audience: Audience; onAudience: (value: Audience) => void; candidateCount?: number;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  return <>
    <button type="button" className="planner-help-trigger" aria-label="Help & settings" onClick={() => { setStep(0); setOpen(true); }}>
      <Icon name="info" size={17} /><span>Help</span>
    </button>
    {open && <PlanningDialog title="Help & settings" onClose={() => setOpen(false)}>
      <div className="planner-help">
        <div className="planner-preferences">
          <label className="field">Appearance
            <select value={appearance} onChange={event => onAppearance(event.target.value as Appearance)}>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label className="field">View mode
            <select value={audience} onChange={event => onAudience(event.target.value as Audience)}>
              <option>Public</option><option>Educator</option><option>Planner</option>
            </select>
          </label>
        </div>
        <details className="advanced-mission">
          <summary>Quick tour</summary>
          <div className="tour-current" aria-live="polite">
            <h3>{tour[step][0]}</h3>
            <p>{tour[step][1]}</p>
          </div>
          <div className="guide-actions">
            {step > 0 && <button type="button" className="secondary-button" onClick={() => setStep(step - 1)}>Previous</button>}
            <button type="button" className="primary-button" onClick={() => step + 1 < tour.length ? setStep(step + 1) : setOpen(false)}>
              {step + 1 < tour.length ? "Next" : "Start exploring"}
            </button>
          </div>
        </details>
        <details className="advanced-mission">
          <summary>Glossary</summary>
          <dl className="inspection-facts">
            <div><dt>Terrain horizon</dt><dd>The skyline formed by hills and ridges as seen from a site.</dd></div>
            <div><dt>Solar elevation</dt><dd>How high the Sun is in the sky, measured in degrees above level ground.</dd></div>
            <div><dt>Earthset</dt><dd>When Earth drops behind the terrain from this location.</dd></div>
            <div><dt>Direct to Earth</dt><dd>A radio path directly from the Moon to Earth. Geometry indicates when line of sight is possible.</dd></div>
          </dl>
        </details>
        <details className="advanced-mission">
          <summary>About Lumen</summary>
          <p>Lumen is a research prototype for lunar mission planning.</p>
          {candidateCount !== undefined && <p>The current dataset covers {candidateCount.toLocaleString()} detailed polar locations.</p>}
          <p>Results describe modeled geometry. Assess landing safety and radio performance with mission-specific analysis.</p>
        </details>
      </div>
    </PlanningDialog>}
  </>;
}

const placeCategories = [
  ["clps", "CLPS missions"], ["artemis_region", "Artemis regions"], ["historic", "Historic missions"], ["feature", "Features"],
] as const;
type PlaceCategory = typeof placeCategories[number][0];

export function CuratedPicker({ features, onPick }: { features: LunarFeature[]; onPick: (site: CuratedSite) => void }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<PlaceCategory>(import.meta.env.VITE_LUMEN_MOCK === "1" ? "artemis_region" : "clps");
  const [sites, setSites] = useState<CuratedSite[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [historic, setHistoric] = useState<CuratedSite | null>(null);
  const replayBack = useRef<HTMLButtonElement>(null);
  const activeCategory = useRef<HTMLButtonElement>(null);
  const restoreCategory = useRef(false);
  useEffect(() => {
    if (historic) replayBack.current?.focus();
    else if (restoreCategory.current) {
      activeCategory.current?.focus();
      restoreCategory.current = false;
    }
  }, [historic]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setCatalogError("");
    getCuratedSites(controller.signal).then(data => { if (!controller.signal.aborted) setSites(data); }).catch(() => {
      if (!controller.signal.aborted) setCatalogError("The curated catalog is unavailable. Approved terrain features are still available.");
    });
    return () => controller.abort();
  }, [open]);
  const approved = features.filter(feature => feature.approved).map(feature => ({
    ...feature, kind: "feature" as const,
    analysis: (feature.latitude_deg <= -87 ? "detailed" : "coarse") as CuratedSite["analysis"], blurb: "",
  }));
  const list = category === "clps" ? sites.filter(site => site.kind === "historic" && clpsMissions[site.id])
    : category === "feature" && !sites.some(site => site.kind === "feature") ? approved
    : sites.filter(site => site.kind === category);
  function select(site: CuratedSite) {
    if (site.kind === "historic") setHistoric(site);
    else { onPick(site); setOpen(false); }
  }

  return <div className="curated-picker">
    <button className="text-button" onClick={() => setOpen(true)}>Browse lunar places <Icon name="arrow" size={15} /></button>
    {open && <PlanningDialog title={historic?.name ?? "Browse lunar places"} onClose={() => { setHistoric(null); setOpen(false); }}>
      {historic ? <>
        <button ref={replayBack} className="secondary-button" onClick={() => {
          restoreCategory.current = true;
          setHistoric(null);
        }}>Back to lunar places</button>
        {clpsMissions[historic.id] && <section className="clps-mission-details" aria-labelledby="clps-mission-title">
          <h3 id="clps-mission-title">Recorded mission</h3>
          <ClpsMissionDetails site={historic} />
        </section>}
        <MissionReplay key={historic.id} site={historic} />
        {!clpsMissions[historic.id] && <p><a href={historic.source_url} target="_blank" rel="noreferrer">Mission source</a></p>}
      </> : <>
        <div className="scenario-tools" role="group" aria-label="Place categories">
          {placeCategories.map(([kind, name]) => <button key={kind} className="secondary-button"
            ref={category === kind ? activeCategory : undefined} aria-pressed={category === kind} onClick={() => setCategory(kind)}>{name}</button>)}
        </div>
        {!list.length && <p role="status">{catalogError || "No places in this category have loaded yet."}</p>}
        {category === "clps" ? <ul className="clps-mission-grid">{list.map(site => (
          <li className="clps-mission-card" key={site.id}>
            <h3>{site.name}</h3><ClpsMissionDetails site={site} summary />
            <button className="secondary-button" onClick={() => select(site)} aria-label={`Open mission and replay for ${site.name}`}>Open mission and replay</button>
          </li>
        ))}</ul> : <ul className="curated-list">{list.map(site => (
          <li key={site.id}><div><strong>{site.name}</strong><p>{site.analysis === "detailed" ? "Detailed coverage" : "Coarse coverage"}{site.blurb ? ` · ${site.blurb}` : ""}</p></div>
            <button className="secondary-button" onClick={() => select(site)}>{site.kind === "historic" ? "Open replay" : "Choose place"}</button>
            {site.id === CONNECTING_RIDGE_ID ? <CraterInspection /> : null}
          </li>
        ))}</ul>}
      </>}
    </PlanningDialog>}
  </div>;
}
