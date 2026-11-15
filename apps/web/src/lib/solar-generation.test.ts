import { describe, expect, it } from "vitest";
import { nearestSolarPoint, solarSegments } from "./solar-generation";

const at = (time: string) => Date.parse(`2028-10-05T${time}:00Z`);
const sample = (time_utc: string, vertical_w: number) => ({ time_utc, vertical_w, horizontal_w: 42 });
const utc = (time: string, watts: number) => sample(`2028-10-05T${time}:00Z`, watts);

describe("solar generation", () => {
  it("plots zero and the exact mission end on an absolute UTC axis", () => {
    const start = at("00:12");
    const end = at("02:27");
    const samples = [
      utc("00:11", 10),
      utc("02:27", 320),
      sample("2028-10-04T17:12:00-07:00", 0),
      utc("02:12", 300),
      utc("01:12", 200),
      utc("02:28", 325),
      sample("invalid", 75),
      utc("01:42", Number.NaN),
    ];
    expect(solarSegments(samples, start, end)).toEqual([[
      { time: start, watts: 0 },
      { time: at("01:12"), watts: 200 },
      { time: at("02:12"), watts: 300 },
      { time: end, watts: 320 },
    ]]);
  });

  it("keeps hourly samples together and leaves a gap longer than 65 minutes", () => {
    const segments = solarSegments([
      utc("01:00", 120),
      utc("02:05", 180),
      utc("03:11", 200),
      utc("04:11", 400),
    ], at("00:00"), at("05:00"));

    expect(segments.map(segment => segment.map(point => point.time))).toEqual([
      [at("01:00"), at("02:05")],
      [at("03:11"), at("04:11")],
    ]);
    expect(nearestSolarPoint(segments, at("00:59"))).toBeUndefined();
    expect(nearestSolarPoint(segments, at("02:05"))?.watts).toBe(180);
    expect(nearestSolarPoint(segments, at("02:06"))).toBeUndefined();
    expect(nearestSolarPoint(segments, at("04:12"))).toBeUndefined();
  });

  it("uses the nearest sampled time and chooses the earlier sample at a tie", () => {
    const start = at("00:00");
    const end = at("01:00");
    const segments = solarSegments([utc("00:00", 0), utc("01:00", 120)], start, end);

    expect(nearestSolarPoint(segments, at("00:30"))).toEqual({ time: start, watts: 0 });
    expect(nearestSolarPoint(segments, at("00:31"))).toEqual({ time: end, watts: 120 });
    expect(solarSegments(undefined, start, end)).toEqual([]);
  });
});
