import { useId } from "react";
import { cutoffTerrainEvidence } from "../lib/cutoff-terrain";
import type { CutoffType } from "../lib/cutoff-terrain";
import { coordinateLabel } from "../lib/hemisphere";
import type { Candidate } from "../lib/types";
import "./cutoff-terrain.css";

const utc = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "UTC",
});

function instantLabel(instant: string) {
  const parsed = Date.parse(instant);
  return Number.isFinite(parsed) ? `${utc.format(parsed)} UTC` : "Time unavailable";
}

function angle(degrees: number) {
  return `${degrees.toFixed(3)}°`;
}

function SightLine({ clearance, scale, visible }: { clearance: number; scale: number; visible: boolean }) {
  const horizon = 32;
  const bodyY = horizon - 21 * clearance / scale;
  const position = clearance === 0 ? "at" : `${angle(Math.abs(clearance))} ${clearance > 0 ? "above" : "below"}`;
  return <svg className="cutoff-sight-line" viewBox="0 0 220 64" role="img"
    aria-label={`Schematic line of sight. The body is ${position} the modeled horizon.`}>
    <rect x="10" y={horizon} width="200" height="24" rx="2" className="cutoff-blocked-region" />
    <line x1="10" y1={horizon} x2="210" y2={horizon} className="cutoff-horizon-line" />
    <line x1="10" y1={horizon} x2="210" y2={bodyY} className={visible ? "cutoff-visible-line" : "cutoff-obscured-line"} />
    <circle cx="10" cy={horizon} r="3" className="cutoff-observer" />
    <circle cx="210" cy={bodyY} r="4" className={visible ? "cutoff-visible-body" : "cutoff-obscured-body"} />
  </svg>;
}

type CutoffProps = {
  site: Candidate;
  type: CutoffType;
  timeUtc: string;
  uncertaintyMinutes: number;
  refined: boolean;
  onInspectSample?: (time: number) => void;
};

export function CutoffTerrainEvidence({ site, type, timeUtc, uncertaintyMinutes, refined, onInspectSample }: CutoffProps) {
  const title = useId();
  const evidence = cutoffTerrainEvidence(site, type, timeUtc);
  const earthset = type === "earthset";
  const body = earthset ? "Earth" : "Sun";
  const point = earthset ? "Earth center" : "Sun’s upper edge";
  const readings = evidence ? [
    { sample: evidence.before, geometry: evidence.visibleElevation, state: "Last visible sample" },
    { sample: evidence.after, geometry: evidence.blockedElevation, state: "First blocked sample" },
  ].map(reading => {
    const elevation = earthset ? reading.geometry.elevation : reading.geometry.upperLimb;
    const clearance = elevation === undefined ? undefined : elevation - reading.geometry.horizon;
    return { ...reading, elevation, clearance };
  }) : [];
  const diagramScale = Math.max(.01, ...readings.map(({ clearance }) => Math.abs(clearance ?? 0)));
  const uncertainty = Number.isFinite(uncertaintyMinutes) && uncertaintyMinutes > 0
    ? ` · ±${Math.round(uncertaintyMinutes * 60)} s`
    : "";
  return <section className="horizon-sample cutoff-terrain" aria-labelledby={title}>
    <h4 id={title}>{earthset ? "Why Earth sets here" : "Why the Sun sets here"}</h4>
    <p><strong><time dateTime={timeUtc}>{instantLabel(timeUtc)}</time></strong> · {refined ? "Refined estimate" : "Sample midpoint estimate"}{uncertainty}</p>
    {!evidence ? <p>The bracketing geometry samples are unavailable for this event.</p> : <>
      <p>{earthset ? "Earth’s center drops behind the modeled horizon." : "The Sun’s upper edge drops behind the modeled horizon."} The model uses the samples below to bracket the cutoff.</p>
      <div className="cutoff-terrain-grid">
        {readings.map(({ sample, geometry, state, elevation, clearance }) => <div className="cutoff-terrain-reading" key={sample.time_utc}>
            <h5>{state}</h5>
            <time dateTime={sample.time_utc}>{instantLabel(sample.time_utc)}</time>
            <dl>
              <div><dt>{elevation === undefined ? "Sun center elevation" : `${point} elevation`}</dt><dd>{angle(elevation ?? geometry.elevation)}</dd></div>
              <div><dt>Modeled horizon</dt><dd>{angle(geometry.horizon)}</dd></div>
              {clearance !== undefined && <div><dt>Clearance</dt><dd>{clearance > 0 ? "+" : ""}{angle(clearance)}</dd></div>}
              {clearance === undefined && <div><dt>Solar disk visible</dt><dd>{(sample.solar_fraction * 100).toFixed(1)}%</dd></div>}
            </dl>
            {clearance !== undefined && <SightLine clearance={clearance} scale={diagramScale} visible={geometry.visible} />}
            {onInspectSample && <button className="text-button" type="button" aria-label={`Show ${state.toLowerCase()} in elevation charts`} onClick={() => onInspectSample(Date.parse(sample.time_utc))}>Show in elevation charts</button>}
          </div>)}
      </div>
      {readings.some(reading => reading.clearance !== undefined) && <p className="field-hint">The horizontal line marks the modeled horizon at each bearing. The vertical scale is enlarged, and the shaded region marks directions below the horizon.</p>}
      {evidence.blocker ? <div className="cutoff-terrain-blocker">
        <h5>Terrain in the blocked direction</h5>
        <p>At the first blocked sample, {body} is at <strong>{evidence.blockedElevation.azimuth.toFixed(1)}° bearing</strong>. The horizon at that bearing comes from the <strong>{evidence.blocker.azimuth_deg.toFixed(1)}° terrain ray</strong>, with a modeled obstruction <strong>{(evidence.blocker.distance_m / 1000).toFixed(2)} km away</strong>.</p>
        {evidence.blocker.blocker_latitude_deg != null && evidence.blocker.blocker_longitude_deg_east != null && <p>Approximate blocker coordinates {coordinateLabel({ latitude_deg: evidence.blocker.blocker_latitude_deg, longitude_deg_east: evidence.blocker.blocker_longitude_deg_east })}.</p>}
        <p className="field-hint">The model uses the higher of the two adjacent terrain rays. The blocker is estimated at the displayed sample time.</p>
      </div> : <p className="field-hint">No terrain blocker is available for this bearing. The samples still show the modeled horizon and visibility change.</p>}
    </>}
    {earthset && <p className="field-hint">Earthset is a geometric cutoff. A contact window with an extra clearance margin can end earlier.</p>}
  </section>;
}
