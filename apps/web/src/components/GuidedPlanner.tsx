import { useEffect, useMemo, useRef, useState } from "react";
import type { Candidate, LunarFeature, PSRLayer, RegionManifest, SearchRequest, SearchResponse, TerrainData } from "../lib/types";
import { getFeatures, getPSRLayer, getRegionManifest, getSiteAnalysis, getTerrain } from "../lib/api";
import type { CoverageCatalog, CoverageOutcome } from "../lib/planning";
import { areaName, canonical, coverageLabel, priorityName, publicLimitErrors, refineSurveyRequest, usesHemisphereTerrain } from "../lib/planning";
import { getCoverage, PlanningError, previewCoverage } from "../lib/planning-api";
import { useSearchPreparation } from "../lib/use-search-preparation";
import { DEFAULT_REQUEST, shiftWindow } from "../lib/missions";
import { downloadJson, utcRange } from "../lib/format";
import type { Appearance } from "../lib/appearance";
import { VerifiedArea } from "./VerifiedArea";
import { MissionStyles } from "./MissionStyles";
import { Leaderboard } from "./Leaderboard";
import { SiteDetails } from "./SiteDetails";
import { BackupPlans } from "./BackupPlans";
import { SiteLocations } from "./SiteLocations";
import { useBackgroundRanking } from "../lib/background-ranking";
import { applyStyle } from "../lib/mission-styles";
import { loadScenario, scenarioKey } from "../lib/scenarios";
import type { Scenario } from "../lib/scenarios";
import { COMPARE_LIMIT } from "../lib/compare-sites";
import type { Audience } from "../lib/scenarios";
import { sharedScenarios } from "../lib/scenarios";
import { demoComparison } from "../lib/demo-comparison";
import { SharedScenarioBoard } from "./SharedScenarioBoard";
import { ScenarioBoard } from "./ScenarioBoard";
import { CuratedPicker, ExperienceTools } from "./ExperienceTools";
import type { SceneSite } from "../lib/scene-geometry";
import { MissionSummary, PlanningEvidence } from "./PlanningEvidence";
import { MissionLibrary } from "./MissionStudio";
import { SearchBudget } from "./SearchBudget";
import { Icon } from "./Icon";
import "./guided-planner.css";

function initialRequest(): SearchRequest {
  return { ...structuredClone(DEFAULT_REQUEST), region: { selector_type: "circle", center: { latitude_deg: -89.9, longitude_deg_east: 0 }, search_radius_km: 3 },
    time_range: { start_utc: "2028-10-01T00:00:00Z", end_utc: "2028-10-08T00:00:00Z" } };
}
const phases = { timeout: "Search time limit reached", submitting: "Submitting mission", queued: "Waiting in the queue", running: "Analysis running", complete: "Analysis complete", canceled: "Analysis canceled", failed: "Analysis failed", expired: "Analysis expired", queue_full: "The queue is full", waking: "Service waking up", outside: "Outside prepared coverage" };
export function GuidedPlanner({ appearance, onAppearance }: { appearance: Appearance; onAppearance: (value: Appearance) => void }) {
  const [shared, setShared] = useState(() => sharedScenarios(window.location.hash));
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<SearchRequest>(initialRequest);
  const [catalog, setCatalog] = useState<CoverageCatalog | null>(null);
  const [manifest, setManifest] = useState<RegionManifest | null>(null);
  const [terrain, setTerrain] = useState<TerrainData | null>(null);
  const [features, setFeatures] = useState<LunarFeature[]>([]);
  const [psr, setPsr] = useState<PSRLayer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [coverageRefresh, setCoverageRefresh] = useState(0);
  const [coverage, setCoverage] = useState<CoverageOutcome | null>(null);
  const [coverageError, setCoverageError] = useState<string | null>(null);
  const [coveragePending, setCoveragePending] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [review, setReview] = useState(false);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [appliedCoverage, setAppliedCoverage] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [extraSite, setExtraSite] = useState<Candidate | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [summarySites, setSummarySites] = useState<Candidate[]>([]);
  const [audience, setAudience] = useState<Audience>("Public");
  const [modal, setModal] = useState<"site" | "summary" | null>(null);
  const [library, setLibrary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ phase: string; message: string; queue_position?: number } | null>(null);
  const [validation, setValidation] = useState<string[]>([]);
  const [styleChosen, setStyleChosen] = useState(false);
  const [picks, setPicks] = useState<string[]>([]);
  const [details, setDetails] = useState<{ site: Candidate; label: string; start: string; end: string } | null>(null);
  const [chosen, setChosen] = useState<{ row: Scenario; label: string } | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const ranking = useBackgroundRanking(catalog);
  const requestController = useRef<AbortController | null>(null);
  const inspectionController = useRef<AbortController | null>(null);
  const version = useRef(0);
  const regionKey = canonical(draft.region);
  const preparation = useSearchPreparation(draft.region, busy || ranking.status?.state === "running", catalog?.public_limits.maximum_radius_km ?? 5);

  useEffect(() => {
    const abort = new AbortController(); setLoadError(null);
    Promise.all([getCoverage(abort.signal), getRegionManifest(abort.signal)]).then(([next, info]) => {
      if (abort.signal.aborted) return;
      if (!next.verified) throw new Error("The service has not verified scientific coverage.");
      setCatalog(next); setManifest(info);
    }).catch(reason => { if (!abort.signal.aborted) setLoadError(reason.message); });
    getTerrain(abort.signal).then(next => { if (!abort.signal.aborted) setTerrain(next); }).catch(() => {});
    getFeatures(abort.signal).then(next => { if (!abort.signal.aborted) setFeatures(next.features); }).catch(() => {});
    getPSRLayer(abort.signal).then(next => { if (!abort.signal.aborted) setPsr(next); }).catch(() => {});
    return () => abort.abort();
  }, [refresh]);
  useEffect(() => () => { requestController.current?.abort(); inspectionController.current?.abort(); version.current++; }, []);
  useEffect(() => { document.querySelector<HTMLHeadingElement>(".guide-stage:not([hidden]) h1[tabindex]")?.focus(); }, [step, review, shared]);
  useEffect(() => {
    if (!catalog) return;
    const abort = new AbortController(); setCoverage(null); setCoverageError(null); setCoveragePending(true); setAcknowledged(false);
    const timer = setTimeout(() => {
      previewCoverage(JSON.parse(regionKey), abort.signal).then(next => {
        if (!abort.signal.aborted) { setCoverage(next); setCoveragePending(false); }
      }).catch(reason => { if (!abort.signal.aborted) { setCoverageError(reason.message); setCoveragePending(false); } });
    }, 180);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [catalog, regionKey, coverageRefresh]);

  const stale = !!result && canonical(draft) !== canonical(result.request);
  // Keep the area controls laid out like the last result while a new area is checked.
  const lastCoverage = useRef(coverage);
  if (coverage) lastCoverage.current = coverage;
  const shownCoverage = coverage ?? (coveragePending ? lastCoverage.current : null);
  const areaReady = !!catalog && !coveragePending && coverage && coverage.status !== "outside" && (coverage.status !== "partial" || acknowledged);
  const radiusExceedsLimit = !!catalog && draft.region.selector_type !== "full_supported_region" && draft.region.selector_type !== "southern_hemisphere" && (draft.region.search_radius_km ?? 0) > catalog.public_limits.maximum_radius_km;
  const canShowDemo = import.meta.env.VITE_LUMEN_MOCK !== "1" && catalog?.geometry.type === "cap";
  const currentStep = shared.length ? 4 : step;
  const appliedKey = coverage ? canonical({ ...draft, region: coverage.region }) : "";
  // Rank in the background as soon as a mission style is chosen, and again whenever the mission changes.
  useEffect(() => {
    if (step !== 2 || !styleChosen || !catalog || !coverage || !areaReady) return;
    const timer = setTimeout(() => {
      if (!missionErrors().length) ranking.start(structuredClone({ ...draft, region: coverage.region }));
    }, 300);
    return () => clearTimeout(timer);
  }, [step, styleChosen, appliedKey, areaReady]); // eslint-disable-line react-hooks/exhaustive-deps
  const rankedLocations = useMemo<SceneSite[]>(() => result ? result.candidates.map(site => ({ ...site,
    illumination_fraction: site.metrics.illumination_fraction, earth_visibility_fraction: site.metrics.earth_visibility_fraction })) : [], [result]);
  const eligibleLocations = useMemo<SceneSite[]>(() => {
    const ranks = new Map(result?.candidates.map(site => [site.id, site.rank]) ?? []);
    return (result?.map_candidates ?? []).flatMap(point => point.latitude_deg == null || point.longitude_deg_east == null ? []
      : [{ ...point, latitude_deg: point.latitude_deg, longitude_deg_east: point.longitude_deg_east, rank: ranks.get(point.id) }]);
  }, [result]);
  const resultTerrain = result && usesHemisphereTerrain(result.request) ? result.terrain_data ?? null : terrain;
  const site = result?.candidates.find(item => item.id === selected) ?? extraSite;
  function update(request: SearchRequest) {
    if (busy) { version.current++; requestController.current?.abort(); setBusy(false); setState({ phase: "canceled", message: "The request was canceled because its inputs changed. Your previous applied results are retained." }); }
    if (canonical(request.region) !== regionKey) { setCoverage(null); setCoverageError(null); setCoveragePending(true); setAcknowledged(false); }
    setDraft(structuredClone(request)); setReview(false); setValidation([]);
  }
  function go(next: number) {
    setStep(next); setReview(false); setValidation([]);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function continueToMission() {
    if (!coverage || !areaReady || radiusExceedsLimit) return;
    if (shared.length) closeShared();
    setDraft(current => ({ ...current, region: coverage.region }));
    go(2);
  }
  function missionErrors() {
    if (!catalog || !areaReady || !coverage) return ["Return to Area and verify coverage before submitting."];
    const errors = publicLimitErrors(draft, catalog);
    if (Date.parse(draft.time_range.start_utc) < Date.parse(manifest?.valid_time_range.start_utc ?? "2025-01-01") || Date.parse(draft.time_range.end_utc) > Date.parse(manifest?.valid_time_range.end_utc ?? "2036-01-01")) errors.push("Choose dates within the backend-advertised ephemeris range.");
    if (!usesHemisphereTerrain(draft) && !catalog.layers.psr_distance && draft.hard_constraints.maximum_distance_to_psr_km != null) errors.push("The applied PSR-distance requirement is unavailable. Remove it explicitly under More options or load a dataset with that layer.");
    return errors;
  }

  async function run() {
    const errors = missionErrors();
    if (errors.length || !catalog || !coverage) { setValidation(errors); setReview(false); return; }
    requestController.current?.abort(); inspectionController.current?.abort();
    const abort = new AbortController(); requestController.current = abort;
    const current = ++version.current;
    const applied = structuredClone({ ...draft, region: coverage.region });
    const coverageText = `${coverageLabel(applied.region, catalog)}; ${coverage.status === "partial" ? "acknowledged supported intersection only" : "supported selection"}; ${coverage.candidate_count.toLocaleString()} prepared candidate locations.`;
    setBusy(true); setStep(3); setModal(null); setInspecting(false); setValidation([]);
    const job = ranking.take(applied) ?? ranking.start(applied);
    if (!job) { setBusy(false); return; }
    const head = Math.round((Date.now() - job.started) / 1000);
    setState({ phase: "running", message: job.state === "ready" ? "Ranked in the background." : head > 0 ? `Ranking started in the background ${head}s ago…` : "Ranking sites…" });
    try {
      const next = await Promise.race([job.promise, new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(new DOMException("Canceled", "AbortError")), { once: true }))]);
      if (abort.signal.aborted || current !== version.current) return;
      if (!next.counts.region) throw new PlanningError("This area has no supported candidate locations. Choose another area; this is not a successful empty search.", "outside", 422);
      setResult(next); setDraft(structuredClone(next.request)); setAppliedCoverage(coverageText);
      setSelected(next.candidates[0]?.id ?? null); setExtraSite(null); setSummarySites([]);
      setPicks([...next.candidates].sort((a, b) => a.rank - b.rank).slice(0, 2).map(site => site.id)); setChosen(null);
      setState({ phase: "complete", message: next.candidates.length ? "Your leaderboard is ready." : "The supported area was analyzed, but no sites meet every required limit." });
    } catch (reason) {
      if (abort.signal.aborted || current !== version.current) return;
      setState({ phase: reason instanceof PlanningError ? reason.code : "failed", message: reason instanceof Error ? reason.message : "Analysis failed. Inputs are retained." });
    } finally { if (current === version.current && !abort.signal.aborted) setBusy(false); }
  }
  function cancel() {
    version.current++; requestController.current?.abort(); ranking.cancel(); setBusy(false);
    setState({ phase: "canceled", message: "Cancellation requested. Your mission inputs and previous results are retained." });
  }
  async function inspect(id: string) {
    if (!result) return;
    inspectionController.current?.abort();
    setInspecting(false);
    const known = result.candidates.find(item => item.id === id);
    if (known) { setSelected(id); setExtraSite(null); setModal("site"); return; }
    const point = result.map_candidates?.find(item => item.id === id); if (!point) return;
    const abort = new AbortController(); inspectionController.current = abort; setInspecting(true);
    try {
      const detail = await getSiteAnalysis(id, result.request, abort.signal);
      if (abort.signal.aborted) return;
      setSelected(id); setExtraSite({ ...detail.site, rank: 0, score: point.score, criteria_scores: point.criteria_scores ?? { illumination: null, earth_visibility: null, terrain_safety: null, science_proximity: null }, metrics: detail.metrics, timeline: detail.timeline, horizon: detail.horizon }); setModal("site");
    } catch (reason) { if (!abort.signal.aborted) setState({ phase: "failed", message: reason instanceof Error ? reason.message : "Inspection unavailable." }); }
    finally { if (!abort.signal.aborted) setInspecting(false); }
  }
  function closeShared() {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    setShared([]);
  }
  function openArea() {
    if (shared.length) closeShared();
    go(1);
  }
  function openDemo() {
    setShared(demoComparison);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function openCompare() {
    if (!shared.length && result && picks.length) go(4);
  }
  function openLeaderboard() {
    if (shared.length) closeShared();
    if (result && !stale && !busy) { go(3); return; }
    if (busy) { go(3); return; }
    void run();
  }
  function togglePick(id: string) {
    setPicks(current => current.includes(id) ? current.filter(item => item !== id) : current.length >= COMPARE_LIMIT ? current : [...current, id]);
  }
  function openDetails(site: Candidate, label: string) {
    if (!result) return;
    setDetails({ site, label, start: result.request.time_range.start_utc, end: result.request.time_range.end_utc });
  }
  async function switchSite(id: string) {
    if (!chosen || !result) return;
    setSwitching(id);
    try {
      const row = await loadScenario(id, chosen.row.request, new AbortController().signal, false);
      const ranked = result.candidates.find(site => site.id === id);
      setChosen({ row: { ...row, key: scenarioKey(id, row.request) }, label: ranked ? `Candidate ${ranked.rank}` : "Backup site" });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (reason) {
      setState({ phase: "failed", message: reason instanceof Error ? reason.message : "That site could not be analyzed." });
    } finally { setSwitching(null); }
  }
  return <>
    <header className="planner-masthead">
      <div className="planner-masthead-inner">
        <a className="brand" href="#top" aria-label="Lumen home" onClick={event => { event.preventDefault(); openArea(); }}>
          <img src="/lumen-mark.svg" alt="" /><span>Lumen</span>
        </a>
        <nav className="guide-steps" aria-label="Planning stages">
          <button type="button" aria-current={currentStep === 1 ? "step" : undefined} onClick={openArea}>Area</button>
          <button type="button" aria-current={currentStep === 2 ? "step" : undefined}
            disabled={!areaReady || radiusExceedsLimit} onClick={continueToMission}>Mission</button>
          <button type="button" aria-current={currentStep === 3 ? "step" : undefined}
            disabled={currentStep !== 3 && !result && !busy} onClick={() => go(3)}>Leaderboard</button>
          <button type="button" aria-current={currentStep === 4 ? "step" : undefined}
            disabled={currentStep !== 4 && !(result && picks.length)} onClick={openCompare}>Compare</button>
          <button type="button" aria-current={currentStep === 5 ? "step" : undefined}
            disabled={currentStep !== 5 && !chosen} onClick={() => go(5)}>Your site</button>
        </nav>
        <ExperienceTools appearance={appearance} onAppearance={onAppearance}
          audience={audience} onAudience={setAudience} candidateCount={catalog?.candidate_count} />
      </div>
    </header>
    <div className={`guided-planner explorer-${currentStep === 1 ? "area" : currentStep === 2 ? "mission" : "comparison"}`} id="explorer">
      {shared.length > 0 && <SharedScenarioBoard links={shared} demo={shared === demoComparison} audience={audience} terrain={terrain} onChooseArea={openArea} />}
      <div hidden={shared.length > 0} className="planner-mission-workspace">
    {!busy && step === 1 && <p className={`preparation-state ${preparation.state}`} role="status" aria-live="polite" title={preparation.message}>{preparation.state === "preparing" ? "Preparing search data in the background · submit whenever you’re ready" : preparation.state === "ready" ? "Search data ready · mission calculations run on submission" : "Background preparation unavailable · you can submit normally"}</p>}
    {import.meta.env.VITE_LUMEN_MOCK === "1" && <p className="changed-notice" role="status">Mock mode · synthetic analysis and replay data</p>}
    {result && stale && <div className="changed-notice" role="status">These results and exports use the previous mission. Review and run your edits to update them.</div>}
    {loadError && <div className="guide-error" role="alert"><h2>Service waking up or coverage unavailable</h2><p>{loadError}</p><p>Your inputs are retained.</p><button className="secondary-button" onClick={() => setRefresh(value => value + 1)}>Retry loading coverage</button></div>}
    {!catalog && !loadError && <p role="status">Loading the verified coverage catalog…</p>}
    {catalog && <section hidden={step !== 1} className="guide-stage guide-area-stage">
      <header className="guide-stage-heading guide-display-heading">
        <h1 tabIndex={-1}>Choose an area</h1>
        <p>Pick where to search on the Moon. You’ll choose individual sites after setting your mission.</p>
        <div className="guide-stage-tools">
          <CuratedPicker features={features} onPick={place => update({ ...draft, region: { selector_type: "circle", center: { latitude_deg: place.latitude_deg, longitude_deg_east: place.longitude_deg_east }, search_radius_km: 3 } })} />
          {canShowDemo && <button className="text-button" onClick={openDemo}>Open the demo comparison <Icon name="arrow" size={15} /></button>}
        </div>
      </header>
      <VerifiedArea terrain={terrain} catalog={catalog} request={draft} features={features} outcome={coverage} pending={coveragePending} error={coverageError} onChange={update} onRetry={() => setCoverageRefresh(value => value + 1)} actions={<>
        {shownCoverage?.status === "partial" && <label className="coverage-ack"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />Analyze the covered portion of this area.</label>}
        {radiusExceedsLimit && <p className="guide-error">Choose a radius of {catalog.public_limits.maximum_radius_km} km or less, or select the full-region demo.</p>}
        <button hidden={shownCoverage?.status === "outside"} className="primary-button" disabled={!areaReady || radiusExceedsLimit} onClick={continueToMission}>Continue to mission <Icon name="arrow" size={16} /></button>
      </>} />
    </section>}
    {catalog && step === 2 && <section className="guide-stage guide-mission-stage">
      <header className="guide-stage-heading guide-display-heading">
        <h1 tabIndex={-1}>Set the mission</h1>
        <p>Choose the dates and a mission style. Ranking starts in the background the moment you pick a style.</p>
      </header>
      <MissionStyles request={draft} catalog={catalog} features={features} chosen={styleChosen} ranking={ranking.status} rankingKey={appliedKey}
        onPick={style => { update(applyStyle(draft, style)); setStyleChosen(true); }} onChange={update} onOpenLibrary={() => setLibrary(true)} />
      <div className="guide-actions">
        <button className="secondary-button" onClick={() => go(1)}>Back to area</button>
        <button className="primary-button" onClick={openLeaderboard}>See the leaderboard <Icon name="arrow" size={16} /></button>
      </div>
      {validation.length > 0 && <div className="guide-error" role="alert"><ul>{validation.map(text => <li key={text}>{text}</li>)}</ul></div>}
    </section>}
    {step === 3 && <section className="guide-stage guide-leaderboard-stage">
      <header className="guide-stage-heading guide-display-heading">
        <h1 tabIndex={-1}>Leaderboard</h1>
        <p>{areaName(draft.region)} · {priorityName(draft)} · {utcRange(draft.time_range)}</p>
      </header>
      {state && !busy && state.phase !== "complete" && <div className={`analysis-status ${state.phase}`} role="status"><strong>{phases[state.phase as keyof typeof phases] ?? "Analysis update"}</strong><p>{state.message}</p>
        <button className="secondary-button" onClick={() => go(2)}>Review the mission</button></div>}
      {result && !busy && result.request.region.selector_type === "southern_hemisphere" && catalog?.hemisphere_detailed && <section className="hemisphere-refinement" aria-label="Refine survey results"><div><h2>Explore a shortlisted area in detail.</h2><p>The survey compares regional locations about 150 km apart using coarse horizons. Refine a local area with detailed LOLA terrain and locally traced horizons.</p></div><div className="guide-actions">{result.candidates.slice(0, 3).map((candidate, index) => <button className="secondary-button" key={candidate.id} onClick={() => { update(refineSurveyRequest(result.request, candidate)); go(1); }}>Refine Candidate {index + 1}</button>)}</div></section>}
      <Leaderboard result={busy ? null : result} pending={busy} statusText={state?.message} regionCount={coverage?.candidate_count}
        selected={picks} onToggle={togglePick} onCompare={() => go(4)}
        onDetails={id => { const site = result?.candidates.find(item => item.id === id); if (site) openDetails(site, `Candidate ${site.rank}`); }} />
      {busy && <div className="guide-actions"><SearchBudget /><button className="secondary-button" onClick={cancel}>Cancel ranking</button></div>}
      <div className="guide-actions">
        {result && !busy && rankedLocations.length > 0 && <button className="secondary-button" onClick={() => setMapOpen(true)}>See sites on the terrain</button>}
        <button className="text-button" onClick={() => go(2)}>Edit mission</button>
        <button className="text-button" onClick={() => go(1)}>Choose another area</button>
      </div>
    </section>}
    {result && <section className="guide-stage guide-compare-stage" hidden={step !== 4}>
      <header className="guide-stage-heading guide-display-heading">
        <h1 tabIndex={-1}>Compare sites</h1>
        <p>{areaName(result.request.region)} · {priorityName(result.request)} · pick one to plan around</p>
      </header>
      <ScenarioBoard key={`${result.search_id}:${picks.join(",")}`} result={result} audience={audience} terrain={resultTerrain}
        initialSelectedIds={picks} hideRankings onInspect={id => void inspect(id)} onSummarySelection={setSummarySites}
        onDetails={(row, label) => setDetails({ site: row.site, label, start: row.request.time_range.start_utc, end: row.request.time_range.end_utc })}
        onChoose={(row, label) => { setChosen({ row, label: label.replace(/^Site [A-D] · /, "") }); go(5); }} />
      <details className="advanced-mission applied-mission-tools"><summary>Mission exports</summary><div className="guide-actions">
        <button className="secondary-button" onClick={() => setModal("summary")}>Create mission summary</button>
        <button className="secondary-button" onClick={() => downloadJson(result, `lumen-${result.search_id}.json`)}>Export scientific JSON</button>
      </div></details>
      <div className="guide-actions"><button className="secondary-button" onClick={() => go(3)}>Back to leaderboard</button><button className="text-button" onClick={() => go(2)}>Edit mission</button></div>
    </section>}
    {step === 5 && result && chosen && <section className="guide-stage guide-backup-stage">
      <header className="guide-stage-heading guide-display-heading">
        <h1 tabIndex={-1}>Your site</h1>
        <p>Ready answers for the problems that most often change a landing plan.</p>
      </header>
      <BackupPlans chosen={chosen.row} label={chosen.label} result={result} switching={switching} onSwitch={id => void switchSite(id)} />
      <div className="guide-actions">
        <button className="secondary-button" onClick={() => setDetails({ site: chosen.row.site, label: chosen.label, start: chosen.row.request.time_range.start_utc, end: chosen.row.request.time_range.end_utc })}>View from the site</button>
        <button className="text-button" onClick={() => go(4)}>Back to compare</button>
      </div>
    </section>}
    {inspecting && <p role="status">Loading this location’s evidence…</p>}
    {result && modal === "site" && site && <PlanningEvidence key={`${result.search_id}-${site.id}`} site={site} result={result} compare={summarySites.map(item => item.id)} terrain={resultTerrain} manifest={manifest} psr={result && usesHemisphereTerrain(result.request) ? null : psr} features={result && usesHemisphereTerrain(result.request) ? [] : features} onExplore={id => void inspect(id)} stale={stale} onDelay={hours => { update(shiftWindow(result.request, hours)); setModal(null); go(2); }} onClose={() => setModal(null)} />}
    {result && modal === "summary" && <MissionSummary result={result} sites={summarySites} coverage={appliedCoverage} stale={stale} onClose={() => setModal(null)} />}
    {details && <SiteDetails key={details.site.id} site={details.site} label={details.label} start={details.start} end={details.end} overview={resultTerrain} onClose={() => setDetails(null)} />}
    {mapOpen && result && <SiteLocations sites={rankedLocations} eligible={eligibleLocations} eligibleTotal={result.counts.temporal_pass}
      dates={result.request.time_range} onClose={() => setMapOpen(false)} onInspect={id => { const site = result.candidates.find(item => item.id === id); if (site) openDetails(site, `Candidate ${site.rank}`); }}
      onToggleCompare={id => { if (result.candidates.some(site => site.id === id)) togglePick(id); }}
      compared={new Map(picks.map((id, index) => [id, String.fromCharCode(65 + index)]))} comparisonFull={picks.length >= COMPARE_LIMIT} />}
    {library && <MissionLibrary value={draft} scienceAvailable={!!catalog?.layers.psr_distance} onLoad={request => { update(request); go(1); }} onClose={() => setLibrary(false)} />}
      </div>
    </div>
  </>;
}
