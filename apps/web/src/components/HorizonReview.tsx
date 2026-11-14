import { useEffect, useId, useRef, useState } from "react";
import { reviewHorizon } from "../lib/api";
import type { HorizonReviewResult, HorizonSample } from "../lib/api";
import { utcTime } from "../lib/format";
import type { TimeSample } from "../lib/types";

const MAX_SAMPLES = 2048;
const MAX_TIMESTAMPS = 5;
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

export function HorizonReview({ timeline }: { timeline: TimeSample[] }) {
  const title = useId();
  const activeRequest = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [review, setReview] = useState<{
    result: HorizonReviewResult;
    times: string[];
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
          times: result.disagreement_indices
            .slice(0, MAX_TIMESTAMPS)
            .map(index => samples[index]?.time_utc)
            .filter((time): time is string => time !== undefined),
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
          {review.result.near_horizon_samples != null && (
            <p>{review.result.near_horizon_samples.toLocaleString()} samples have the Sun’s upper edge or Earth’s center within 0.1° of the terrain horizon.</p>
          )}
          <p className="horizon-review-runtime">
            <span title={review.result.runtime_version}>
              {review.result.engine}{review.result.runtime_version && ` ${review.result.runtime_version.split("-")[0]}`}
            </span>
            {" · "}{review.result.device} · {review.result.model}
            {review.result.inference_ms != null && ` · ${review.result.inference_ms.toFixed(2)} ms inference`}
          </p>
          {review.times.length > 0 && (
            <details>
              <summary>See differing timestamps</summary>
              <ul>{review.times.map((time, index) => (
                <li key={`${time}-${index}`}><time dateTime={time}>{utcTime(time)}</time></li>
              ))}</ul>
              {review.result.disagreement_indices.length > review.times.length && (
                <p>Showing the first {review.times.length} differing timestamps.</p>
              )}
            </details>
          )}
        </div>
      )}
    </section>
  );
}
