import { useEffect, useState } from "react";
import { clpsMissions } from "../data/clps-missions";
import { getHistoricReplay } from "../lib/experience-api";
import type { CuratedSite, Replay } from "../lib/experience-api";
import { utcDate, utcTime } from "../lib/format";
import "./clps-missions.css";

const coordinateSource = "https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_artifact_impacts.html";

function landingCoordinate(site: CuratedSite) {
  const { latitude_deg: latitude, longitude_deg_east: longitude } = site;
  return `${Math.abs(latitude)}° ${latitude < 0 ? "S" : "N"}, ${Math.abs(longitude)}° ${longitude < 0 ? "W" : "E"}`;
}

export function ClpsMissionDetails({ site, summary = false }: { site: CuratedSite; summary?: boolean }) {
  const mission = clpsMissions[site.id];
  if (!mission) return null;

  return <>
    <p className="clps-mission-provider">{mission.provider}{site.landing_utc && <> · <time dateTime={site.landing_utc}>{utcDate(site.landing_utc)}</time></>}</p>
    {summary ? <p>{mission.landingSite}</p> : <dl className="clps-mission-facts">
      <div><dt>Intended destination</dt><dd>{mission.target}</dd></div>
      <div><dt>Recorded landing</dt><dd>{mission.landingSite} · {landingCoordinate(site)}</dd></div>
    </dl>}
    <p>{mission.outcome}</p>
    {summary ? <p><strong>Selected payloads</strong> {mission.payloads.map(payload => payload.name).join(", ")}</p> : <>
      <h4>Selected payloads</h4>
      <ul className="clps-payloads">{mission.payloads.map(payload => (
        <li key={payload.name}><strong>{payload.name}.</strong> {payload.purpose}</li>
      ))}</ul>
      <ul className="clps-sources" aria-label="NASA sources">
        {mission.sources.map(source => <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.label}</a></li>)}
        <li><a href={coordinateSource} target="_blank" rel="noreferrer">NASA coordinates</a></li>
      </ul>
    </>}
  </>;
}

function nearestSample(timeline: Replay["timeline"], instant?: string) {
  const target = Date.parse(instant ?? "");
  if (!Number.isFinite(target)) return 0;
  return timeline.reduce((nearest, point, index) =>
    Math.abs(Date.parse(point.time_utc) - target) < Math.abs(Date.parse(timeline[nearest].time_utc) - target) ? index : nearest,
  0);
}

export function MissionReplay({ site }: { site: CuratedSite }) {
  const [replay, setReplay] = useState<Replay | null>(null);
  const [error, setError] = useState(false);
  const [period, setPeriod] = useState<"landing" | "fortnight">("landing");
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const landing = replay?.landing_utc ?? site.landing_utc;
  const timeline = period === "fortnight" ? replay?.missionTimeline : replay?.timeline;

  useEffect(() => {
    const controller = new AbortController();
    getHistoricReplay(site.id, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setIndex(nearestSample(data.timeline, data.landing_utc ?? site.landing_utc));
      setReplay(data);
    }).catch(() => {
      if (!controller.signal.aborted) setError(true);
    });
    return () => controller.abort();
  }, [site.id, site.landing_utc]);

  useEffect(() => {
    if (!playing || !timeline || index >= timeline.length - 1) return;
    const timer = window.setTimeout(() => setIndex(index + 1), 500);
    return () => window.clearTimeout(timer);
  }, [index, playing, timeline]);

  function selectPeriod(next: typeof period) {
    setPeriod(next);
    setIndex(nearestSample((next === "fortnight" ? replay?.missionTimeline : replay?.timeline) ?? [], landing));
    setPlaying(false);
  }

  const sample = timeline?.[index];
  const advancing = playing && index < (timeline?.length ?? 0) - 1;
  return <section className="clps-replay" aria-labelledby="clps-replay-title">
    <h3 id="clps-replay-title">Modeled landing replay</h3>
    {landing && <p>Touchdown · <time dateTime={landing}>{utcTime(landing)}</time></p>}
    <p>Coarse replay with a flat horizon. The model shows Sun and Earth geometry at the recorded landing point. Actual terrain shadows, lander orientation, and communications are outside this replay model.</p>
    {sample && timeline ? <>
      <div className="clps-replay-controls">
        {!!replay?.missionTimeline?.length && <label className="field">Replay period
          <select value={period} onChange={event => selectPeriod(event.target.value as typeof period)}>
            <option value="landing">12 hours either side of touchdown</option>
            <option value="fortnight">14 days from touchdown</option>
          </select>
        </label>}
        <button className="secondary-button" onClick={() => {
          if (advancing) { setPlaying(false); return; }
          if (index >= timeline.length - 1) setIndex(0);
          setPlaying(true);
        }}>{advancing ? "Pause replay" : "Play replay"}</button>
        <button className="secondary-button" onClick={() => {
          setIndex(nearestSample(timeline, landing));
          setPlaying(false);
        }}>Jump to touchdown</button>
      </div>
      {period === "fortnight" && <p>This model continues for 14 days even if the mission ended earlier.</p>}
      <label className="field">Replay time · <time dateTime={sample.time_utc}>{utcTime(sample.time_utc)}</time>
        <input type="range" min={0} max={timeline.length - 1} value={index}
          aria-label="Replay time" aria-valuetext={utcTime(sample.time_utc)}
          onChange={event => { setPlaying(false); setIndex(Number(event.target.value)); }} />
      </label>
      <dl className="clps-mission-facts clps-replay-values">
        <div><dt>Sun elevation</dt><dd><span data-metric={`${site.id}:sun_elevation_deg`} data-raw={sample.sun_elevation_deg}>{sample.sun_elevation_deg.toFixed(1)}°</span>
          {sample.sun_visible != null && <small>{sample.sun_visible ? "Some solar disk visible" : "Solar disk below the horizon"}</small>}
        </dd></div>
        {sample.earth_elevation_deg != null && (
          <div><dt>Earth elevation</dt><dd><span data-metric={`${site.id}:earth_elevation_deg`} data-raw={sample.earth_elevation_deg}>{sample.earth_elevation_deg.toFixed(1)}°</span>
            {sample.earth_visible != null && <small>{sample.earth_visible ? "Center above the horizon" : "Center at or below the horizon"}</small>}
          </dd></div>
        )}
      </dl>
    </> : <p role="status">{error ? "This mission’s replay is unavailable." : replay ? "This replay contains no samples." : "Loading historic replay…"}</p>}
  </section>;
}
