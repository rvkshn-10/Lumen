#!/usr/bin/env python3
"""Generate scripts/verify/fixtures/contract-v2.json.

A SearchResponse-shaped example that includes every *new* v2 field
(power, events, alternatives, suitability_class). Values come from the
independent oracle + reference_models, so UI tracks can build against real
numbers before the backend lands, and the verifier's feature checks have a
positive control. It is NOT app output; `fixture` in the JSON says so.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reference_models as ref  # noqa: E402
from oracle_ephemeris import Ephemeris, local_sky  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
ANCHORS = {"slope_deg": None, "roughness_m": None, "elevation_m": None}


def iso(t):
    return t.isoformat().replace("+00:00", "Z")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kernels", default=str(ROOT / "data/raw/kernels"))
    ap.add_argument("--tile", default=str(ROOT / "data/derived/lunar-south-cap-v1/tile-3-1/terrain.npz"))
    ap.add_argument("--anchors-from", default=str(ROOT / "data/cache/frontend-usability-qa/regional-analysis.json"))
    ap.add_argument("--out", default=str(ROOT / "scripts/verify/fixtures/contract-v2.json"))
    ap.add_argument("--start", default="2028-10-05T00:00:00Z")
    ap.add_argument("--days", type=int, default=7)
    a = ap.parse_args()

    anchors = json.loads(Path(a.anchors_from).read_text())["provenance"]["score_anchors"]["bounds"]
    eph = Ephemeris(Path(a.kernels))
    tile = np.load(a.tile)
    start = datetime.fromisoformat(a.start.replace("Z", "+00:00"))
    end = start + timedelta(days=a.days)
    times = [start + timedelta(minutes=5 * i) for i in range(a.days * 288 + 1)]
    et = np.array([eph.utc_to_et(t) for t in times])
    sun, earth = eph.apparent(10, et), eph.apparent(399, et, transmit=True)
    hours = ref.hours_between(times)
    duration = a.days * 24.0
    weights = {"illumination": 0.4, "earth_visibility": 0.4, "terrain_safety": 0.2, "science_proximity": 0.0}
    hc = {"maximum_slope_deg": 10, "minimum_earth_visibility_fraction": 0.4,
          "maximum_continuous_darkness_hours": 60}

    rows = []
    for i in range(len(tile["ids"])):
        if tile["slope_deg"][i] > 10:
            continue
        lat, lon, h = float(tile["lat_deg"][i]), float(tile["lon_deg"][i]), float(tile["elevation_m"][i])
        saz, sel, sd = local_sky(lat, lon, h, sun)
        eaz, eel, _ = local_sky(lat, lon, h, earth)
        prof = tile["horizons_deg"][i]
        m = ref.visibility_metrics(sel, ref.horizon_at(prof, saz), sd, eel, ref.horizon_at(prof, eaz), hours)
        crit = ref.category_scores(m, float(tile["slope_deg"][i]), float(tile["roughness_m"][i]), h, duration, anchors)
        crit["science_proximity"] = None
        rows.append((ref.total_score(crit, weights), i, m, crit, saz, sel, sd, eaz, eel))
    rows.sort(key=lambda r: -r[0])
    xy = np.stack([tile["x_m"], tile["y_m"]], 1).astype(float)
    shortlist = []
    for r in rows:
        ok = (r[2]["earth_visibility_fraction"] >= hc["minimum_earth_visibility_fraction"]
              and r[2]["longest_darkness_hours"] <= hc["maximum_continuous_darkness_hours"])
        if ok and all(np.hypot(*(xy[r[1]] - xy[s[1]])) >= 1500 for s in shortlist):
            shortlist.append(r)
        if len(shortlist) == 3:
            break
    failing = next(r for r in rows if r[2]["longest_darkness_hours"] > hc["maximum_continuous_darkness_hours"])

    def candidate(rank, r):
        score, i, m, crit, saz, sel, sd, eaz, eel = r
        prof = tile["horizons_deg"][i]
        sh, eh = ref.horizon_at(prof, saz), ref.horizon_at(prof, eaz)
        pv = ref.power_w(sel, sd, m["_solar_fraction"])
        ph = ref.power_w(sel, sd, m["_solar_fraction"], mount="horizontal")
        events = (ref.transitions(m["_sun_visible"], times, "sunrise", "sunset")
                  + ref.transitions(m["_earth_visible"], times, "earthrise", "earthset"))
        return {
            "id": str(tile["ids"][i]), "rank": rank, "score": score,
            "latitude_deg": float(tile["lat_deg"][i]), "longitude_deg_east": float(tile["lon_deg"][i]),
            "x_m": int(tile["x_m"][i]), "y_m": int(tile["y_m"][i]), "elevation_m": float(tile["elevation_m"][i]),
            "slope_deg": float(tile["slope_deg"][i]), "roughness_m": float(tile["roughness_m"][i]),
            "criteria_scores": crit,
            "metrics": {k: v for k, v in m.items() if not k.startswith("_")},
            "timeline": [{
                "time_utc": iso(t), "sun_azimuth_deg": float(saz[j]), "sun_elevation_deg": float(sel[j]),
                "earth_azimuth_deg": float(eaz[j]), "earth_elevation_deg": float(eel[j]),
                "sun_horizon_deg": float(sh[j]), "earth_horizon_deg": float(eh[j]),
                "solar_fraction": float(m["_solar_fraction"][j]), "sun_visible": bool(m["_sun_visible"][j]),
                "earth_visible": bool(m["_earth_visible"][j]), "sun_distance_km": float(sd[j]),
            } for j, t in enumerate(times)],
            "horizon": [{"azimuth_deg": j * 5.0, "elevation_deg": float(v),
                         "distance_m": float(tile["blocker_distance_m"][i, j])} for j, v in enumerate(prof)],
            "power": {
                "assumptions": {"area_m2": 1.0, "efficiency": 0.30, "mount": "vertical_tracking",
                                "solar_constant_w_m2": ref.SOLAR_CONSTANT_W_M2},
                "series": [{"time_utc": iso(times[j]), "vertical_w": float(pv[j]), "horizontal_w": float(ph[j])}
                           for j in range(0, len(times), 12)],
                "energy_wh": ref.energy_wh(pv, hours),
                "horizontal_energy_wh": ref.energy_wh(ph, hours),
            },
            "events": [{"type": e["type"], "time_utc": iso(e["after"] + (e["before"] - e["after"]) / 2),
                        "uncertainty_minutes": 2.5} for e in events],
        }

    cands = [candidate(k + 1, r) for k, r in enumerate(shortlist)]
    mp = [{"id": str(tile["ids"][r[1]]), "x_m": int(tile["x_m"][r[1]]), "y_m": int(tile["y_m"][r[1]]),
           "latitude_deg": float(tile["lat_deg"][r[1]]), "longitude_deg_east": float(tile["lon_deg"][r[1]]),
           "score": r[0], "illumination_fraction": r[2]["illumination_fraction"],
           "earth_visibility_fraction": r[2]["earth_visibility_fraction"],
           "slope_deg": float(tile["slope_deg"][r[1]]),
           "suitability_class": int(ref.suitability_class(r[0]))} for r in rows]
    # first mapped point must be the top shortlisted score
    mp.sort(key=lambda p: -p["score"])
    alt_src = shortlist[0]
    d_km = float(np.hypot(*(xy[alt_src[1]] - xy[failing[1]]))) / 1000
    alternatives = [{
        "id": str(tile["ids"][alt_src[1]]), "kind": "nearby", "for_site": str(tile["ids"][failing[1]]),
        "distance_km": d_km, "search_radius_km": max(5.0, round(d_km + 0.5, 1)),
        "resolves": ["maximum_continuous_darkness_hours"],
        "metrics": {k: v for k, v in alt_src[2].items() if not k.startswith("_")},
        "reason": (f"{d_km:.1f} km away, the longest dark period drops from "
                   f"{failing[2]['longest_darkness_hours']:.0f} h to {alt_src[2]['longest_darkness_hours']:.0f} h."),
    }]
    out = {
        "fixture": "contract-v2 example generated by scripts/verify/make_contract_fixture.py from the independent oracle; not app output",
        "search_id": "contract-v2", "status": "complete",
        "request": {"region": {"selector_type": "circle", "center": {"latitude_deg": float(tile["lat_deg"].mean()),
                                                                   "longitude_deg_east": float(tile["lon_deg"].mean())},
                               "search_radius_km": 15},
                    "time_range": {"start_utc": iso(start), "end_utc": iso(end)},
                    "hard_constraints": hc, "preferences": {"illumination": 40, "earth_visibility": 40,
                                                            "terrain_safety": 20, "science_proximity": 0}},
        "candidates": cands, "map_candidates": mp, "alternatives": alternatives,
        "normalized_preferences": weights,
        "provenance": {"score_anchors": {"bounds": anchors}, "calculation_frame": "MOON_ME_DE440_ME421"},
        "suitability_legend": {"bins": list(ref.SUITABILITY_BINS[:-1]) + [1.0], "labels": list(ref.SUITABILITY_LABELS)},
    }
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {a.out}: {len(cands)} candidates, {sum(len(c['events']) for c in cands)} events, "
          f"{len(mp)} map points, energy {[round(c['power']['energy_wh']) for c in cands]} Wh")


if __name__ == "__main__":
    main()
