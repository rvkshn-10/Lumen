import type { PowerEstimate } from "./types";

export type SolarPoint = { time: number; watts: number };

// The backend returns roughly hourly samples, with a sample at the mission end.
const MAX_SAMPLE_GAP_MS = 65 * 60_000;

export function solarSegments(samples: PowerEstimate["series"] | undefined, start: number, end: number): SolarPoint[][] {
  if (!samples || !Number.isFinite(start) || !Number.isFinite(end) || start > end) return [];

  const points = samples
    .map(sample => ({ time: Date.parse(sample.time_utc), watts: sample.vertical_w }))
    .filter(point => point.time >= start && point.time <= end && Number.isFinite(point.watts) && point.watts >= 0)
    .sort((a, b) => a.time - b.time);

  const segments: SolarPoint[][] = [];
  let previous: SolarPoint | undefined;
  for (const point of points) {
    if (point.time === previous?.time) continue;
    if (!previous || point.time - previous.time > MAX_SAMPLE_GAP_MS) segments.push([]);
    segments[segments.length - 1].push(point);
    previous = point;
  }
  return segments;
}

export function nearestSolarPoint(segments: SolarPoint[][], time: number): SolarPoint | undefined {
  if (!Number.isFinite(time)) return undefined;

  for (const segment of segments) {
    const first = segment[0];
    const last = segment[segment.length - 1];
    if (!first || time < first.time || time > last.time) continue;

    let nearest = first;
    for (const point of segment) {
      if (Math.abs(point.time - time) < Math.abs(nearest.time - time)) nearest = point;
    }
    return nearest;
  }
  return undefined;
}
