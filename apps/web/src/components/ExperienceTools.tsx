import { useEffect, useState } from "react";
import type { Audience } from "../lib/scenarios";
import { getCuratedSites, getHistoricReplay } from "../lib/experience-api";
import type { CuratedSite, Replay } from "../lib/experience-api";
import { utcTime } from "../lib/format";
import { PlanningDialog } from "./PlanningEvidence";
import type { LunarFeature } from "../lib/types";

const tour = [
  ["Pick", "Choose a place on the Moon. Select a prepared polar area to get detailed results."],
  ["See", "Set a mission window, then find candidate sites. Sunlight and Earth visibility depend on where and when you look."],
  ["Compare", "Select scenarios on the board to see when sunlight or Earth view changes. Duplicate one to try another date."],
];
export function ExperienceTools({ audience, onAudience }: { audience: Audience; onAudience: (value: Audience) => void }) {
  const [panel, setPanel] = useState<"glossary" | "tour" | null>(null);
  const [step, setStep] = useState(0);
  const [firstVisit, setFirstVisit] = useState(() => localStorage.getItem("lumen-tour-seen") !== "1");
  function close() {
    if (panel === "tour") { localStorage.setItem("lumen-tour-seen", "1"); setFirstVisit(false); }
    setPanel(null);
  }
  return <><div className="experience-tools">
    <label className="field">Audience<select value={audience} onChange={event => onAudience(event.target.value as Audience)}><option>Public</option><option>Educator</option><option>Planner</option></select></label>
    <button className="text-button" onClick={() => setPanel("glossary")}>Glossary</button>
    <button className="text-button" onClick={() => { setStep(0); setPanel("tour"); }}>{firstVisit ? "Take the quick tour" : "Quick tour"}</button>
  </div>{panel && <PlanningDialog title={panel === "tour" ? "Plan a lunar scenario" : "Glossary"} onClose={close}>
    {panel === "tour" ? <><h3>{tour[step][0]} · {step + 1} of {tour.length}</h3><p>{tour[step][1]}</p><div className="guide-actions">
      {step > 0 && <button className="secondary-button" onClick={() => setStep(step - 1)}>Previous</button>}
      <button className="primary-button" onClick={() => step + 1 < tour.length ? setStep(step + 1) : close()}>{step + 1 < tour.length ? "Next" : "Start exploring"}</button>
    </div></> : <dl className="inspection-facts">
      <div><dt>Terrain horizon</dt><dd>The skyline formed by hills and ridges as seen from a site.</dd></div>
      <div><dt>Solar elevation</dt><dd>How high the Sun is in the sky, measured in degrees above level ground.</dd></div>
      <div><dt>Earthset</dt><dd>When Earth drops behind the terrain from this location.</dd></div>
      <div><dt>Direct to Earth</dt><dd>A radio path directly from the Moon to Earth. Geometry indicates when a line of sight is possible.</dd></div>
    </dl>}
  </PlanningDialog>}</>;
}

export function CuratedPicker({ features, onPick }: { features: LunarFeature[]; onPick: (site: CuratedSite) => void }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<CuratedSite["kind"]>("artemis_region");
  const [sites, setSites] = useState<CuratedSite[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [replayError, setReplayError] = useState("");
  const [historic, setHistoric] = useState<CuratedSite | null>(null);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setCatalogError("");
    getCuratedSites(controller.signal).then(data => { if (!controller.signal.aborted) setSites(data); }).catch(() => { if (!controller.signal.aborted) setCatalogError("The curated catalog is unavailable. Approved terrain features are still available."); });
    return () => controller.abort();
  }, [open]);
  useEffect(() => {
    if (!historic) return;
    const controller = new AbortController();
    setReplay(null); setIndex(0); setPlaying(false); setReplayError("");
    getHistoricReplay(historic.id, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      const landing = Date.parse(data.landing_utc ?? historic.landing_utc ?? "");
      const nearest = data.timeline.reduce((best, point, i) => Math.abs(Date.parse(point.time_utc) - landing) < Math.abs(Date.parse(data.timeline[best].time_utc) - landing) ? i : best, 0);
      setIndex(nearest);
      setReplay(data);
    }).catch(() => { if (!controller.signal.aborted) setReplayError("This mission’s replay is unavailable."); });
    return () => controller.abort();
  }, [historic]);
  useEffect(() => {
    if (!historic || !playing || !replay?.timeline.length) return;
    if (index >= replay.timeline.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setIndex(index + 1), 500);
    return () => window.clearTimeout(timer);
  }, [historic, index, playing, replay]);
  const approved = features.filter(feature => feature.approved).map(feature => ({ ...feature, kind: "feature" as const, analysis: (feature.latitude_deg <= -87 ? "detailed" : "coarse") as CuratedSite["analysis"], blurb: "" }));
  const list = category === "feature" && !sites.some(site => site.kind === "feature") ? approved : sites.filter(site => site.kind === category);
  const sample = replay?.timeline[index];
  return <div className="curated-picker"><button className="secondary-button" onClick={() => setOpen(true)}>Browse lunar places</button>
    {open && <PlanningDialog title={historic?.name ?? "Browse lunar places"} onClose={() => { setHistoric(null); setOpen(false); }}>
      {historic ? <>
        <button className="secondary-button" onClick={() => { setHistoric(null); setReplayError(""); }}>Back to lunar places</button>
        {historic.landing_utc && <p>Landing · {utcTime(historic.landing_utc)}</p>}
        {sample ? <><p>Coarse replay with a flat horizon.</p><button className="secondary-button" onClick={() => {
          if (!playing && index >= replay!.timeline.length - 1) setIndex(0);
          setPlaying(!playing);
        }}>{playing ? "Pause replay" : "Play replay"}</button><label className="field">Replay time · {utcTime(sample.time_utc)}
          <input type="range" min={0} max={replay!.timeline.length - 1} value={index} onChange={event => { setPlaying(false); setIndex(Number(event.target.value)); }} /></label>
          <p>Sun elevation <span data-metric={`${historic.id}:sun_elevation_deg`} data-raw={sample.sun_elevation_deg}>{sample.sun_elevation_deg.toFixed(1)}°</span>.</p></> : <p role="status">{replayError || (replay ? "This replay contains no samples." : "Loading historic replay…")}</p>}
        <p><a href={historic.source_url} target="_blank" rel="noreferrer">Mission source</a></p>
      </> : <>
        <div className="scenario-tools" role="group" aria-label="Place categories">{([["artemis_region", "Artemis regions"], ["historic", "Historic missions"], ["feature", "Features"]] as const).map(([kind, name]) => <button key={kind} className="secondary-button" aria-pressed={category === kind} onClick={() => setCategory(kind)}>{name}</button>)}</div>
        {!list.length && <p role="status">{catalogError || "No places in this category have loaded yet."}</p>}
        <ul className="curated-list">{list.map(site => <li key={site.id}><div><strong>{site.name}</strong><p>{site.analysis === "detailed" ? "Detailed coverage" : "Coarse coverage"}{site.blurb ? ` · ${site.blurb}` : ""}</p></div><button className="secondary-button" onClick={() => site.kind === "historic" ? setHistoric(site) : (onPick(site), setOpen(false))}>{site.kind === "historic" ? "Open replay" : "Choose place"}</button></li>)}</ul>
      </>}
    </PlanningDialog>}</div>;
}
