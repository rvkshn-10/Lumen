import { describe, expect, it } from "vitest";
import { longestPoweredWindow, meetsPoweredContact, poweredContactAt } from "./powered-contact";
import type { PoweredContactResult } from "./types";

const first = { start_utc: "2028-10-01T00:05:00Z", end_utc: "2028-10-01T00:10:00Z", duration_hours: 5 / 60 };
const second = { start_utc: "2028-10-01T00:15:00Z", end_utc: "2028-10-01T00:25:00Z", duration_hours: 10 / 60 };
const result: PoweredContactResult = {
  windows: [first, second], dte_windows: [first, second], longest_contact_hours: 10 / 60,
  first_depletion_utc: second.end_utc, min_reserve_wh: 0, reserve_series: [],
};

describe("powered contact", () => {
  it("uses the longest continuous window for a duration check", () => {
    expect(longestPoweredWindow(result)).toEqual(second);
    expect(meetsPoweredContact(result, 10 / 60)).toBe(true);
    expect(meetsPoweredContact(result, 11 / 60)).toBe(false);
    expect(meetsPoweredContact(result, 0)).toBe(false);
  });

  it("treats the window end as exclusive and leaves a gap between windows", () => {
    expect(poweredContactAt(result, Date.parse(first.start_utc))).toBe(true);
    expect(poweredContactAt(result, Date.parse(first.end_utc))).toBe(false);
    expect(poweredContactAt(result, Date.parse(second.end_utc) - 1)).toBe(true);
    expect(poweredContactAt(result, Date.parse(second.end_utc))).toBe(false);
  });
});
