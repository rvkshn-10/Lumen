import type { SearchRequest } from "./types";
import { MISSION_PRESETS } from "./missions";
import { normalizePreferences } from "./weights";

export interface MissionStyle {
  id: string;
  name: string;
  blurb: string;
  needs?: "psr";
  preferences: SearchRequest["preferences"];
  hard_constraints: SearchRequest["hard_constraints"];
}
const preset = (id: string) => MISSION_PRESETS.find(item => item.id === id)!.request;

/** Mission styles the planner offers. Weights and limits are planner inputs, not measurements. */
export const MISSION_STYLES: MissionStyle[] = [
  { id: "balanced", name: "Balanced", blurb: "Even weight on sunlight and Earth contact, on slopes under 10°.", ...pick(preset("balanced")) },
  { id: "solar", name: "Maximize sunlight", blurb: "Power first: the longest sunlight, slopes under 10°.", ...pick(preset("solar")) },
  { id: "contact", name: "Keep Earth in view", blurb: "Longest direct line of sight to Earth for communications.", ...pick(preset("contact")) },
  { id: "safe", name: "Safest ground", blurb: "Flattest, smoothest terrain, slopes under 8°.",
    preferences: { illumination: 20, earth_visibility: 20, terrain_safety: 60, science_proximity: 0 }, hard_constraints: { maximum_slope_deg: 8 } },
  { id: "science", name: "Near permanent shadow", blurb: "Close to mapped permanently shadowed regions.", needs: "psr", ...pick(preset("science")) },
];

function pick(request: SearchRequest) {
  return { preferences: structuredClone(request.preferences), hard_constraints: structuredClone(request.hard_constraints) };
}

export function applyStyle(request: SearchRequest, style: MissionStyle): SearchRequest {
  return { ...request, preferences: structuredClone(style.preferences), hard_constraints: structuredClone(style.hard_constraints) };
}

export function activeStyle(request: SearchRequest) {
  const weights = normalizePreferences(request.preferences);
  return MISSION_STYLES.find(style => {
    const expected = normalizePreferences(style.preferences);
    return (Object.keys(weights) as (keyof typeof weights)[]).every(key => Math.abs(weights[key] - expected[key]) < 1e-8);
  });
}
