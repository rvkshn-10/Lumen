import type { Scenario } from "./scenarios";
import type { PoweredContactResult, PoweredContactWindow } from "./types";

export function getPoweredContact(row: Scenario): PoweredContactResult | undefined {
  return row.site.power?.powered_contact;
}

export function longestPoweredWindow(result: PoweredContactResult): PoweredContactWindow | undefined {
  return result.windows.reduce<PoweredContactWindow | undefined>(
    (longest, window) => !longest || window.duration_hours > longest.duration_hours ? window : longest,
    undefined,
  );
}

export function meetsPoweredContact(result: PoweredContactResult, minimumHours: number) {
  return Number.isFinite(minimumHours) && minimumHours > 0 && result.longest_contact_hours >= minimumHours;
}

export function poweredContactAt(result: PoweredContactResult, time: number) {
  return result.windows.some(window => Date.parse(window.start_utc) <= time && time < Date.parse(window.end_utc));
}
