import { DEFAULT_REQUEST } from "./missions";
import type { ScenarioLink } from "./scenarios";
import type { SearchRequest } from "./types";

const request: SearchRequest = {
  ...DEFAULT_REQUEST,
  region: {
    selector_type: "circle",
    center: { latitude_deg: -87.2671, longitude_deg_east: -160.2402 },
    search_radius_km: 5,
  },
  time_range: { start_utc: "2028-10-05T00:00:00Z", end_utc: "2028-10-12T00:00:00Z" },
  hard_constraints: { maximum_slope_deg: 10 },
};

export const demoComparison: ScenarioLink[] = [
  { id: "lola--27000--79500", label: "Site A", request },
  { id: "lola--29000--76500", label: "Site B", request },
];
