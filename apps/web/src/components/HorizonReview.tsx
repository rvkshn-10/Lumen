import { useEffect, useId, useRef, useState } from "react";
import { reviewHorizon } from "../lib/api";
import type { HorizonReviewResult, HorizonSample } from "../lib/api";
import { utcTime } from "../lib/format";
import type { TimeSample } from "../lib/types";

const MAX_SAMPLES = 2048;
const DISAGREEMENT_PAGE_SIZE = 5;
const formatClearance = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 4,
  signDisplay: "always",
});
const formatAgreement = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 2,
});

function reviewSamples(timeline: TimeSample[]): HorizonSample[] {
  const count = Math.min(MAX_SAMPLES, timeline.length);
  return Array.from({ length: count }, (_, index) => {
    const sampleIndex = timeline.length <= MAX_SAMPLES
      ? index
      : Math.round(index * (timeline.length - 1) / (count - 1));
    const {
      time_utc,
      sun_elevation_deg,
      sun_horizon_deg,
      earth_elevation_deg,
      earth_horizon_deg,
      sun_visible,
      earth_visible,
    } = timeline[sampleIndex];
    return {
      time_utc,
      sun_elevation_deg,
      sun_horizon_deg,
      earth_elevation_deg,
      earth_horizon_deg,
      sun_visible,
      earth_visible,
    };
  });
}

function HorizonDisagreements({
  result,
  sampleTimes,
  onInspect,
}: {
  result: HorizonReviewResult;
  sampleTimes: string[];
  onInspect?: (time: string) => void;
}) {
  const [band, setBand] = useState<"all" | "near" | "outside">("all");
  const [limit, setLimit] = useState(DISAGREEMENT_PAGE_SIZE);
  const disagreements = result.disagreements?.filter(item =>
    band === "all" || item.near_horizon === (band === "near"),
  );

  if (!disagreements) {
    const times = result.disagreement_indices
      .slice(0, DISAGREEMENT_PAGE_SIZE)
      .map(index => sampleTimes[index])
      .filter(time => time !== undefined);
    return times.length > 0 && (
      <details>
        <summary>See differing timestamps</summary>
        <ul>{times.map(time => <li key={time}><time dateTime={time}>{utcTime(time)}</time></li>)}</ul>
      </details>
    );
  }
  if (result.disagreements?.length === 0) return <p>Both labels matched at every reviewed timestamp.</p>;

  return (
    <details>
      <summary>Inspect differing labels</summary>
      <label className="field horizon-review-filter">
        Clearance band
        <select value={band} onChange={event => {
          setBand(event.target.value as typeof band);
          setLimit(DISAGREEMENT_PAGE_SIZE);
        }}>
          <option value="all">All disagreements</option>
          <option value="near">Near the horizon</option>
          <option value="outside">Outside the horizon band</option>
        </select>
      </label>
      <p>{disagreements.length.toLocaleString()} differing labels in this view.</p>
      <ul className="horizon-review-differences">
        {disagreements.slice(0, limit).map(item => {
          const time = sampleTimes[item.sample_index];
          const body = item.body === "sun" ? "Sun" : "Earth";
          return (
            <li key={`${item.sample_index}-${item.body}`}>
              <strong>{body}</strong> · {time && <time dateTime={time}>{utcTime(time)}</time>}
              <dl>
                <div><dt>Terrain clearance</dt><dd>{formatClearance.format(item.clearance_deg)}°</dd></div>
                <div><dt>Physics</dt><dd>{item.physics_visible ? "Visible" : "Blocked"}</dd></div>
                <div><dt>OpenVINO</dt><dd>{item.model_visible ? "Visible" : "Blocked"}</dd></div>
              </dl>
              {time && onInspect && <button className="secondary-button" type="button" onClick={() => onInspect(time)}>Show in chart</button>}
            </li>
          );
        })}
      </ul>
      {limit < disagreements.length && (
        <button className="secondary-button" type="button" onClick={() => setLimit(current => current + DISAGREEMENT_PAGE_SIZE)}>
          Show more differing labels
        </button>
      )}
    </details>
  );
}

export function HorizonReview({
  timeline,
  onInspect,
}: {
  timeline: TimeSample[];
  onInspect?: (time: string) => void;
}) {
  const title = useId();
  const activeRequest = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [review, setReview] = useState<{
    result: HorizonReviewResult;
    sampleTimes: string[];
  } | null>(null);

  useEffect(() => () => activeRequest.current?.abort(), []);

  async function runReview() {
    if (activeRequest.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setPending(true);
    setError("");
    setReview(null);
    const samples = reviewSamples(timeline);

    try {
      const result = await reviewHorizon(samples, controller.signal);
      if (!controller.signal.aborted) {
        setReview({
          result,
          sampleTimes: samples.map(sample => sample.time_utc),
        });
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : "Could not run the horizon review.");
      }
    } finally {
      activeRequest.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return (
    <section className="horizon-review" aria-labelledby={title}>
      <header>
        <h3 id={title}>OpenVINO horizon review</h3>
        <p>
          Compare a small AI model’s Sun and Earth visibility estimates with
          Lumen’s physics-based timeline. Mission scores use the physics model.
        </p>
      </header>
      <div className="horizon-review-action">
        <button className="secondary-button" type="button" disabled={pending || timeline.length === 0} onClick={() => void runReview()}>
          {review ? "Run OpenVINO again" : "Run OpenVINO review"}
        </button>
        <p role="status">{pending
          ? "Running OpenVINO on the server CPU…"
          : timeline.length > MAX_SAMPLES
            ? `Reviews ${MAX_SAMPLES.toLocaleString()} evenly spaced samples across this window.`
            : timeline.length
              ? `Reviews all ${timeline.length.toLocaleString()} samples in this window.`
              : "This site has no timeline samples to review."}</p>
      </div>
      {error && <p className="error-box" role="alert">{error} You can still inspect the physics timeline.</p>}
      <details>
        <summary>How the model works</summary>
        <p>
          The model learns from synthetic examples of bodies crossing a horizon. It takes
          two angles, how far the Sun and Earth are above or below the local terrain
          horizon, and predicts visibility for each. OpenVINO runs those predictions
          on the server CPU.
        </p>
      </details>
      {review && (
        <div className="horizon-review-result">
          <p role="status">
            <strong>{formatAgreement.format(review.result.agreement)} joint agreement</strong> across{" "}
            {review.result.samples.toLocaleString()} samples. Both visibility estimates must match for a sample to count.
          </p>
          <dl className="inspection-facts horizon-review-facts">
            <div><dt>Sun visibility agreement</dt><dd>{formatAgreement.format(review.result.sun_agreement)}</dd></div>
            <div><dt>Earth visibility agreement</dt><dd>{formatAgreement.format(review.result.earth_agreement)}</dd></div>
          </dl>
          {review.result.near_horizon && review.result.outside_horizon_band && (
            <>
              <dl className="inspection-facts horizon-review-facts">
                <div><dt>Within {review.result.near_horizon_deg}° of the horizon</dt><dd>{review.result.near_horizon.disagreements.toLocaleString()} of {review.result.near_horizon.labels.toLocaleString()} labels differ</dd></div>
                <div><dt>Outside the horizon band</dt><dd>{review.result.outside_horizon_band.disagreements.toLocaleString()} of {review.result.outside_horizon_band.labels.toLocaleString()} labels differ</dd></div>
              </dl>
              <p>Clearance is positive above the terrain. This review uses Earth’s center and an approximate upper edge of the Sun to identify borderline samples.</p>
            </>
          )}
          <p className="horizon-review-runtime">
            <span title={review.result.runtime_version}>
              {review.result.engine}{review.result.runtime_version && ` ${review.result.runtime_version.split("-")[0]}`}
            </span>
            {" · "}{review.result.device} · {review.result.model}
            {review.result.inference_ms != null && ` · ${review.result.inference_ms.toFixed(2)} ms inference`}
          </p>
          <HorizonDisagreements result={review.result} sampleTimes={review.sampleTimes} onInspect={onInspect} />
        </div>
      )}
    </section>
  );
}
