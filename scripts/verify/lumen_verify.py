#!/usr/bin/env python3
"""lumen-verify: independent checker for Lumen's data and results.

Nothing here imports backend/app. Ephemerides come from a separate DAF/Chebyshev
reader (oracle_ephemeris.py); every derived number is recomputed from
reference_models.py and compared with what the app produced.

Suites
  data         integrity of kernels, cap catalog, tiles and temporal cache
  ephemeris    Sun/Earth az/el in every result timeline vs the oracle
  visibility   horizon lookup, disk fraction, visible flags, 7 window metrics
  scoring      criteria, weighted score, rank order, 1.5 km separation
  cache        fresh oracle recomputation of random cap sites vs the cached window
  metamorphic  properties that must hold under perturbation (horizon +1 deg, ...)
  physics      bounds that any south-polar site must satisfy
  features     contracts for new features (power, events, alternatives,
               suitability colour map, curated sites); SKIP until implemented

Iterate mode (--iterate N) re-runs randomised suites with fresh seeds and growing
samples until N consecutive clean passes or the first failure; failures are
written with a minimal reproduction. The baseline ratchet (--baseline) stores the
worst observed error per check; a later run fails if a check regresses beyond
max(tolerance, 2 x baseline). Use --update-baseline after a reviewed improvement.

Usage (repository root, project venv active):
  python scripts/verify/lumen_verify.py                       # all suites, defaults
  python scripts/verify/lumen_verify.py --result out.json     # check an exported analysis
  python scripts/verify/lumen_verify.py --iterate 5 --report data/cache/verify
  python scripts/verify/lumen_verify.py --result r.json --scene-dump scene.json --ui-dump ui.json

Dump formats (written by the Playwright smoke step):
  scene: {"samples":[{"site_id","time_utc","sun_azimuth_deg","sun_elevation_deg","earth_azimuth_deg",
          "earth_elevation_deg","sun_horizon_deg","earth_horizon_deg","sun_visible","earth_visible"}]}
  ui:    {"values":[{"key":"<site id>:<metric|energy_wh|score>","raw":0.7213,"displayed":"72%",
          "scale":100,"decimals":0}]}
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import math
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reference_models as ref  # noqa: E402
from oracle_ephemeris import Ephemeris, local_sky  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
METRICS = ("illumination_fraction", "earth_visibility_fraction", "longest_sunlight_hours",
           "longest_darkness_hours", "longest_communication_hours", "longest_blackout_hours",
           "mean_visible_solar_disk_fraction")
TOL = {  # absolute tolerances; documented in docs/verification.md
    "angle_deg": 1e-6,
    "fraction": 1e-9,
    "hours": 1e-6,
    "score": 1e-6,
    "cache_fraction": 1e-9,
    "power_rel": 1e-6,
}


def parse_t(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def daz(a, b):
    return np.abs((np.asarray(a) - np.asarray(b) + 180) % 360 - 180)


class Report:
    def __init__(self):
        self.rows: list[dict] = []

    def add(self, suite, name, ok, *, err=None, tol=None, detail="", repro=None, skip=False):
        status = "skip" if skip else ("pass" if ok else "fail")
        self.rows.append({"suite": suite, "check": name, "status": status,
                          "max_error": None if err is None else float(err),
                          "tolerance": tol, "detail": detail, "repro": repro})
        return ok

    def failed(self):
        return [r for r in self.rows if r["status"] == "fail"]

    def summary(self):
        c = {s: sum(r["status"] == s for r in self.rows) for s in ("pass", "fail", "skip")}
        return c


# ------------------------------------------------------------------ helpers

class Context:
    def __init__(self, args):
        self.args = args
        self.kernels = Path(args.kernels)
        self.eph = Ephemeris(self.kernels)
        self._sky = {}

    def bodies(self, times):
        key = (times[0], times[-1], len(times))
        if key not in self._sky:
            et = np.array([self.eph.utc_to_et(t) for t in times])
            self._sky[key] = (self.eph.apparent(10, et), self.eph.apparent(399, et, transmit=True))
        return self._sky[key]


def load_results(paths):
    out = []
    for p in paths:
        try:
            out.append((p, json.loads(Path(p).read_text())))
        except (OSError, ValueError) as exc:
            out.append((p, {"_error": str(exc)}))
    return out


# ------------------------------------------------------------------- suites

def suite_data(ctx, rep: Report):
    s = "data"
    man = json.loads((ctx.kernels / "manifest.json").read_text())
    for item in man:
        p = ctx.kernels / item["file"]
        ok = p.exists() and hashlib.sha256(p.read_bytes()).hexdigest() == item["sha256"]
        rep.add(s, f"kernel sha256 {item['file']}", ok, detail=str(p))
    cap = Path(ctx.args.cap)
    tiles = sorted(cap.glob("tile-*/terrain.npz"))
    if not tiles:
        rep.add(s, "cap tiles present", False, skip=True, detail=f"no tiles under {cap}")
        return
    total, bad = 0, []
    for t in tiles:
        z = np.load(t)
        n = len(z["ids"])
        total += n
        h = z["horizons_deg"]
        checks = {
            "lat in [-90,-87]": bool(np.all((z["lat_deg"] >= -90) & (z["lat_deg"] <= -86.99))),
            "lon in [-180,180)": bool(np.all((z["lon_deg"] >= -180) & (z["lon_deg"] < 180))),
            "horizons finite": bool(np.isfinite(h).all()),
            "horizons in [-10,45] deg": bool(np.all((h > -10) & (h < 45))),
            "72 azimuth bins": h.shape[1] == 72,
            "slope in [0,90)": bool(np.all((z["slope_deg"] >= 0) & (z["slope_deg"] < 90))),
            "roughness >= 0": bool(np.all(z["roughness_m"] >= 0)),
            "elevation plausible": bool(np.all(np.abs(z["elevation_m"]) < 11000)),
            "unique ids": len(set(z["ids"].tolist())) == n,
            "500 m grid": bool(np.all(z["x_m"] % 500 == 0) and np.all(z["y_m"] % 500 == 0)),
        }
        bad += [f"{t.parent.name}: {k}" for k, v in checks.items() if not v]
    rep.add(s, f"cap tiles valid ({len(tiles)} tiles, {total} sites)", not bad,
            detail="; ".join(bad[:10]))
    if len(tiles) >= 88:
        rep.add(s, "cap site count == 103996", total == 103996, detail=str(total))
    for cache in ctx.args.cache:
        z = np.load(cache)
        cols = {k: z[k] for k in METRICS}
        n = len(z["ids"])
        frac_ok = all(np.all((cols[k] >= 0) & (cols[k] <= 1 + 1e-12)) for k in METRICS
                      if "fraction" in k)
        dur = max(float(cols["longest_blackout_hours"].max()), float(cols["longest_darkness_hours"].max()))
        sums_ok = bool(np.all(cols["longest_sunlight_hours"] + cols["longest_darkness_hours"] <= dur + 1e-6))
        disk_ok = bool(np.all(cols["mean_visible_solar_disk_fraction"] <= cols["illumination_fraction"] + 1e-12))
        rep.add(s, f"temporal cache sane ({Path(cache).name[:12]}, n={n})",
                frac_ok and sums_ok and disk_ok,
                detail=f"fractions={frac_ok} runs<=window={sums_ok} disk<=illum={disk_ok}")


def suite_ephemeris(ctx, rep, results):
    s = "ephemeris"
    for path, res in results:
        for c in res.get("candidates", []):
            tl = c.get("timeline")
            if not tl:
                continue
            times = [parse_t(r["time_utc"]) for r in tl]
            sun, earth = ctx.bodies(times)
            saz, sel, _ = local_sky(c["latitude_deg"], c["longitude_deg_east"], c["elevation_m"], sun)
            eaz, eel, _ = local_sky(c["latitude_deg"], c["longitude_deg_east"], c["elevation_m"], earth)
            g = lambda k: np.array([r[k] for r in tl])  # noqa: E731
            err = max(np.abs(sel - g("sun_elevation_deg")).max(), daz(saz, g("sun_azimuth_deg")).max(),
                      np.abs(eel - g("earth_elevation_deg")).max(), daz(eaz, g("earth_azimuth_deg")).max())
            rep.add(s, f"{Path(path).name}:{c['id']} Sun/Earth az/el", err <= TOL["angle_deg"],
                    err=err, tol=TOL["angle_deg"],
                    repro={"result": str(path), "candidate": c["id"]})


def suite_visibility_scoring(ctx, rep, results):
    for path, res in results:
        req = res.get("request", {})
        cands = res.get("candidates", [])
        if not cands:
            continue
        start, end = parse_t(req["time_range"]["start_utc"]), parse_t(req["time_range"]["end_utc"])
        duration = (end - start).total_seconds() / 3600
        anchors = res["provenance"]["score_anchors"]["bounds"]
        weights = res["normalized_preferences"]
        for c in cands:
            tl = c.get("timeline")
            name = f"{Path(path).name}:{c['id']}"
            if tl:
                times = [parse_t(r["time_utc"]) for r in tl]
                sun, earth = ctx.bodies(times)
                saz, sel, sd = local_sky(c["latitude_deg"], c["longitude_deg_east"], c["elevation_m"], sun)
                eaz, eel, _ = local_sky(c["latitude_deg"], c["longitude_deg_east"], c["elevation_m"], earth)
                prof = np.array([h["elevation_deg"] for h in c["horizon"]])
                sh, eh = ref.horizon_at(prof, saz), ref.horizon_at(prof, eaz)
                hz_err = max(np.abs(sh - [r["sun_horizon_deg"] for r in tl]).max(),
                             np.abs(eh - [r["earth_horizon_deg"] for r in tl]).max())
                rep.add("visibility", f"{name} horizon lookup", hz_err <= 1e-5, err=hz_err, tol=1e-5)
                m = ref.visibility_metrics(sel, sh, sd, eel, eh, ref.hours_between(times))
                flags = (np.array_equal(m["_sun_visible"], [r["sun_visible"] for r in tl])
                         and np.array_equal(m["_earth_visible"], [r["earth_visible"] for r in tl]))
                rep.add("visibility", f"{name} visible flags", flags,
                        detail="sample flags differ from oracle" if not flags else "")
                sf_err = np.abs(m["_solar_fraction"] - [r["solar_fraction"] for r in tl]).max()
                rep.add("visibility", f"{name} solar disk fraction", sf_err <= 1e-6, err=sf_err, tol=1e-6)
                merr = 0.0
                for k in METRICS:
                    tol = TOL["fraction"] if "fraction" in k else TOL["hours"]
                    merr = max(merr, abs(m[k] - c["metrics"][k]) / (tol / TOL["fraction"]))
                rep.add("visibility", f"{name} window metrics", merr <= TOL["fraction"],
                        err=merr, tol=TOL["fraction"])
                # physics bounds
                colat = 90 - abs(c["latitude_deg"])
                ok_s = np.abs(sel).max() <= colat + 1.6 + 0.3
                ok_e = np.abs(eel).max() <= colat + 7.0 + 1.1
                rep.add("physics", f"{name} Sun |el| <= colat+1.9", bool(ok_s),
                        err=float(np.abs(sel).max()), tol=colat + 1.9)
                rep.add("physics", f"{name} Earth |el| <= colat+8.1", bool(ok_e),
                        err=float(np.abs(eel).max()), tol=colat + 8.1)
                suite_features_candidate(ctx, rep, name, c, times, sel, sd, m)
            crit = ref.category_scores(c["metrics"], c["slope_deg"], c["roughness_m"],
                                       c["elevation_m"], duration, anchors)
            cerr = max(abs(crit[k] - c["criteria_scores"][k]) for k in crit)
            score = ref.total_score({**crit, "science_proximity": c["criteria_scores"].get("science_proximity")}, weights)
            serr = max(cerr * 100, abs(score - c["score"]))
            rep.add("scoring", f"{name} criteria + score", serr <= TOL["score"], err=serr, tol=TOL["score"])
        scores = [c["score"] for c in cands]
        rep.add("scoring", f"{Path(path).name} ranks sorted by score",
                scores == sorted(scores, reverse=True) and [c["rank"] for c in cands] == list(range(1, len(cands) + 1)))
        xy = np.array([[c["x_m"], c["y_m"]] for c in cands], float)
        dmin = min((np.hypot(*(xy[i] - xy[j])) for i in range(len(xy)) for j in range(i)), default=math.inf)
        rep.add("scoring", f"{Path(path).name} shortlist separation >= 1500 m", dmin >= 1500, err=dmin, tol=1500)
        best_map = max((p["score"] for p in res.get("map_candidates", [])), default=None)
        if best_map is not None:
            rep.add("scoring", f"{Path(path).name} top candidate is best mapped score",
                    abs(best_map - scores[0]) < 1e-9)
        suite_features_result(ctx, rep, path, res)


def suite_cache(ctx, rep, rng, sample):
    s = "cache"
    if not ctx.args.cache:
        rep.add(s, "temporal cache available", False, skip=True, detail="no cache npz")
        return
    tiles = sorted(Path(ctx.args.cap).glob("tile-*/terrain.npz"))
    if not tiles:
        rep.add(s, "cap tiles available", False, skip=True)
        return
    cache = np.load(ctx.args.cache[0])
    index = {k: i for i, k in enumerate(cache["ids"].tolist())}
    start, end = parse_t(ctx.args.cache_start), parse_t(ctx.args.cache_end)
    times = [start + timedelta(minutes=5 * i) for i in range(int((end - start).total_seconds() // 300))]
    if times[-1] != end:
        times.append(end)
    sun, earth = ctx.bodies(times)
    hours = ref.hours_between(times)
    tile = np.load(tiles[rng.integers(len(tiles))])
    pick = rng.choice(len(tile["ids"]), size=min(sample, len(tile["ids"])), replace=False)
    worst, worst_id = 0.0, None
    for i in pick:
        sid = str(tile["ids"][i])
        if sid not in index:
            rep.add(s, f"{sid} in cache", False)
            continue
        lat, lon, h = float(tile["lat_deg"][i]), float(tile["lon_deg"][i]), float(tile["elevation_m"][i])
        saz, sel, sd = local_sky(lat, lon, h, sun)
        eaz, eel, _ = local_sky(lat, lon, h, earth)
        prof = tile["horizons_deg"][i]
        m = ref.visibility_metrics(sel, ref.horizon_at(prof, saz), sd, eel, ref.horizon_at(prof, eaz), hours)
        j = index[sid]
        for k in METRICS:
            scale = 1 if "fraction" in k else (end - start).total_seconds() / 3600
            e = abs(m[k] - float(cache[k][j])) / scale
            if e > worst:
                worst, worst_id = e, (sid, k)
    rep.add(s, f"oracle recompute of {len(pick)} sites in {tiles[0].parent.name if len(tiles)==1 else 'random tile'} vs cache",
            worst <= TOL["cache_fraction"], err=worst, tol=TOL["cache_fraction"],
            detail="" if worst_id is None else f"worst {worst_id}",
            repro={"site": None if worst_id is None else worst_id[0], "window": [ctx.args.cache_start, ctx.args.cache_end]})


def suite_metamorphic(ctx, rep, rng, sample):
    s = "metamorphic"
    tiles = sorted(Path(ctx.args.cap).glob("tile-*/terrain.npz"))
    if not tiles:
        rep.add(s, "tiles available", False, skip=True)
        return
    tile = np.load(tiles[rng.integers(len(tiles))])
    start = parse_t(ctx.args.cache_start) + timedelta(days=int(rng.integers(0, 20)))
    times = [start + timedelta(minutes=30 * i) for i in range(48 * 7 + 1)]
    sun, earth = ctx.bodies(times)
    hours = ref.hours_between(times)
    viol = []
    for i in rng.choice(len(tile["ids"]), size=min(sample, len(tile["ids"])), replace=False):
        lat, lon, h = float(tile["lat_deg"][i]), float(tile["lon_deg"][i]), float(tile["elevation_m"][i])
        saz, sel, sd = local_sky(lat, lon, h, sun)
        eaz, eel, _ = local_sky(lat, lon, h, earth)
        prof = tile["horizons_deg"][i]
        base = ref.visibility_metrics(sel, ref.horizon_at(prof, saz), sd, eel, ref.horizon_at(prof, eaz), hours)
        up = ref.visibility_metrics(sel, ref.horizon_at(prof + 1, saz), sd, eel, ref.horizon_at(prof + 1, eaz), hours)
        flat = ref.visibility_metrics(sel, np.full_like(sel, -90.0), sd, eel, np.full_like(eel, -90.0), hours)
        if up["illumination_fraction"] > base["illumination_fraction"] + 1e-12:
            viol.append(f"{tile['ids'][i]} raising horizon increased sunlight")
        if up["earth_visibility_fraction"] > base["earth_visibility_fraction"] + 1e-12:
            viol.append(f"{tile['ids'][i]} raising horizon increased Earth view")
        if abs(flat["illumination_fraction"] - 1) > 1e-12:
            viol.append(f"{tile['ids'][i]} no horizon but not always sunlit")
        if base["mean_visible_solar_disk_fraction"] > base["illumination_fraction"] + 1e-12:
            viol.append(f"{tile['ids'][i]} disk fraction exceeds sunlit fraction")
        pv = ref.power_w(sel, sd, base["_solar_fraction"])
        ph = ref.power_w(sel, sd, base["_solar_fraction"], mount="horizontal")
        if np.any(pv[~base["_sun_visible"]] > 0) or np.any(ph > pv + 1e-9):
            viol.append(f"{tile['ids'][i]} power model property")
    rep.add(s, f"{sample} random sites x 4 properties", not viol, detail="; ".join(viol[:5]))


# Published Sun elevation at touchdown (Apollo mission reports) and a far-side case.
# Track A must attach the exact citations when the curated-site file lands.
HISTORIC_GOLDEN = [
    ("Apollo 11", 0.67408, 23.47297, "1969-07-20T20:17:40Z", 10.8),
    ("Apollo 12", -3.01239, -23.42157, "1969-11-19T06:54:35Z", 5.1),
    ("Apollo 14", -3.64530, -17.47136, "1971-02-05T09:18:11Z", 10.3),
    ("Apollo 15", 26.13222, 3.63386, "1971-07-30T22:16:29Z", 12.0),
    ("Apollo 17", 20.19080, 30.77168, "1972-12-11T19:54:57Z", 13.3),
]


def suite_historic(ctx, rep):
    s = "physics"
    for name, lat, lon, t, published in HISTORIC_GOLDEN:
        et = np.array([ctx.eph.utc_to_et(parse_t(t))])
        el = float(local_sky(lat, lon, 0.0, ctx.eph.apparent(10, et))[1][0])
        rep.add(s, f"{name} Sun elevation at landing vs published {published} deg",
                abs(el - published) <= 0.3, err=abs(el - published), tol=0.3, detail=f"oracle {el:.2f} deg")
    start = parse_t("2019-01-03T00:00:00Z")
    ts = [start + timedelta(hours=2 * i) for i in range(12 * 30)]
    et = np.array([ctx.eph.utc_to_et(x) for x in ts])
    emax = float(local_sky(-45.4446, 177.5991, 0.0, ctx.eph.apparent(399, et, transmit=True))[1].max())
    rep.add(s, "Chang'e 4 (far side) never sees Earth over 30 days", emax < 0, err=emax, tol=0)


# ------------------------------------------------------------ new features

def suite_features_candidate(ctx, rep, name, c, times, sel, sd, m):
    s = "features"
    power = c.get("power")
    if power is None:
        rep.add(s, f"{name} power series", False, skip=True, detail="not implemented yet (Track A)")
    else:
        a = power.get("assumptions", {})
        expected = ref.power_w(sel, sd, m["_solar_fraction"], area_m2=a.get("area_m2", 1.0),
                               efficiency=a.get("efficiency", 0.30))
        got = np.array([p["vertical_w"] for p in power["series"]])
        idx = [times.index(parse_t(p["time_utc"])) for p in power["series"]]
        err = float(np.max(np.abs(got - expected[idx]) / np.maximum(1, expected[idx])))
        rep.add(s, f"{name} power series", err <= TOL["power_rel"], err=err, tol=TOL["power_rel"])
        ewh = ref.energy_wh(expected, ref.hours_between(times))
        rep.add(s, f"{name} window energy", abs(power["energy_wh"] - ewh) <= 1e-6 * max(1, ewh),
                err=abs(power["energy_wh"] - ewh))
    events = c.get("events")
    if events is None:
        rep.add(s, f"{name} sunset/earthset events", False, skip=True, detail="not implemented yet (Track A)")
    else:
        want = (ref.transitions(m["_sun_visible"], times, "sunrise", "sunset")
                + ref.transitions(m["_earth_visible"], times, "earthrise", "earthset"))
        got = sorted((e["type"], parse_t(e["time_utc"])) for e in events)
        ok = len(got) == len(want) and all(
            any(g[0] == w["type"] and w["after"] - timedelta(seconds=1) <= g[1] <= w["before"] + timedelta(seconds=1)
                for g in got) for w in want)
        rep.add(s, f"{name} sunset/earthset events", ok, detail=f"expected {len(want)} got {len(got)}")


def suite_features_result(ctx, rep, path, res):
    s = "features"
    name = Path(path).name
    mc = res.get("map_candidates", [])
    if mc and "suitability_class" not in mc[0]:
        rep.add(s, f"{name} suitability colour map", False, skip=True, detail="not implemented yet (Track A)")
    elif mc:
        exp = ref.suitability_class([p["score"] for p in mc])
        ok = all(p["suitability_class"] == int(e) for p, e in zip(mc, exp))
        rep.add(s, f"{name} suitability colour map", ok)
    alts = res.get("alternatives")
    if alts is None:
        rep.add(s, f"{name} alternatives", False, skip=True, detail="not implemented yet (Track A)")
        return
    hc = res["request"]["hard_constraints"]
    bad = []
    for a in alts:
        mt = a["metrics"]
        for key, metric, minimum in (("minimum_illumination_fraction", "illumination_fraction", True),
                                     ("minimum_earth_visibility_fraction", "earth_visibility_fraction", True),
                                     ("maximum_continuous_darkness_hours", "longest_darkness_hours", False),
                                     ("maximum_continuous_blackout_hours", "longest_blackout_hours", False)):
            lim = hc.get(key)
            if lim is not None and (mt[metric] < lim if minimum else mt[metric] > lim):
                bad.append(f"{a.get('id')} violates {key}")
        if a.get("kind") == "nearby" and a.get("distance_km", 0) > a.get("search_radius_km", 1e9):
            bad.append(f"{a.get('id')} outside stated radius")
        if not a.get("reason"):
            bad.append(f"{a.get('id')} has no plain-language reason")
    rep.add(s, f"{name} alternatives satisfy the failed constraints", not bad, detail="; ".join(bad[:5]))


def suite_curated(ctx, rep):
    s = "features"
    p = Path(ctx.args.curated)
    if not p.exists():
        rep.add(s, "curated sites & historic missions", False, skip=True, detail=f"{p} missing (Track A)")
        return
    sites = json.loads(p.read_text())["sites"]
    bad = []
    ids = [x["id"] for x in sites]
    if len(set(ids)) != len(ids):
        bad.append("duplicate ids")
    for x in sites:
        if not (-90 <= x["latitude_deg"] <= 90 and -180 <= x["longitude_deg_east"] < 180):
            bad.append(f"{x['id']} coordinates out of range")
        if x.get("analysis") == "detailed" and x["latitude_deg"] > -87:
            bad.append(f"{x['id']} marked detailed outside the 87-90S cap")
        if not x.get("source_url", "").startswith("https://"):
            bad.append(f"{x['id']} missing source")
        if x.get("kind") == "historic" and not x.get("landing_utc"):
            bad.append(f"{x['id']} historic mission without landing_utc")
    rep.add(s, f"curated sites ({len(sites)})", not bad, detail="; ".join(bad[:8]))



# ------------------------------------------------------- render parity (B, C)

def _interp_timeline(tl, t):
    ts = np.array([parse_t(r["time_utc"]).timestamp() for r in tl])
    x = t.timestamp()
    j = int(np.clip(np.searchsorted(ts, x) - 1, 0, len(ts) - 2))
    f = (x - ts[j]) / (ts[j + 1] - ts[j])
    out = {}
    for k in ("sun_elevation_deg", "earth_elevation_deg", "sun_horizon_deg", "earth_horizon_deg"):
        out[k] = tl[j][k] + f * (tl[j + 1][k] - tl[j][k])
    for k in ("sun_azimuth_deg", "earth_azimuth_deg"):
        d = (tl[j + 1][k] - tl[j][k] + 180) % 360 - 180
        out[k] = (tl[j][k] + f * d) % 360
    return out


def suite_scene_parity(rep, results, dump_path, tol=0.05):
    """Track B gate: what the 3D scene draws equals the API timeline."""
    dump = json.loads(Path(dump_path).read_text())
    cands = {c["id"]: c for _, r in results for c in r.get("candidates", [])}
    worst, flag_bad = 0.0, []
    for smp in dump["samples"]:
        c = cands.get(smp["site_id"])
        if c is None:
            flag_bad.append(f"unknown site {smp['site_id']}")
            continue
        ref_ = _interp_timeline(c["timeline"], parse_t(smp["time_utc"]))
        for k in ref_:
            e = float(daz(smp[k], ref_[k])) if "azimuth" in k else abs(smp[k] - ref_[k])
            worst = max(worst, e)
        for body, radius in (("sun", 0.27), ("earth", 0.0)):
            margin = ref_[f"{body}_elevation_deg"] + radius - ref_[f"{body}_horizon_deg"]
            if abs(margin) > tol and smp[f"{body}_visible"] != (margin > 0):
                flag_bad.append(f"{smp['site_id']} {smp['time_utc']} {body} drawn {'visible' if smp[f'{body}_visible'] else 'blocked'}")
    rep.add("parity", f"scene draws API angles ({len(dump['samples'])} samples)", worst <= tol, err=worst, tol=tol)
    rep.add("parity", "scene blocked/visible states match API", not flag_bad, detail="; ".join(flag_bad[:5]))


def suite_ui_parity(rep, results, dump_path):
    """Track C gate: every displayed number equals the API value within its rounding."""
    import re
    dump = json.loads(Path(dump_path).read_text())
    cands = {c["id"]: c for _, r in results for c in r.get("candidates", [])}
    bad = []
    for v in dump["values"]:
        site, key = v["key"].split(":", 1)
        c = cands.get(site)
        if c is None:
            bad.append(f"{v['key']}: unknown site")
            continue
        truth = (c["metrics"].get(key) if key in c["metrics"] else
                 c.get("power", {}).get(key) if key in c.get("power", {}) else c.get(key))
        if truth is None:
            bad.append(f"{v['key']}: no such API value")
            continue
        if abs(float(v["raw"]) - float(truth)) > 1e-9 * max(1, abs(truth)):
            bad.append(f"{v['key']}: raw {v['raw']} != API {truth}")
        m = re.search(r"-?\d+(?:[.,]\d+)?", v["displayed"].replace(",", ""))
        if m:
            shown = float(m.group(0)) / v.get("scale", 1)
            if abs(shown - float(truth)) > 0.5 * 10 ** -v.get("decimals", 0) / v.get("scale", 1) + 1e-12:
                bad.append(f"{v['key']}: shows {v['displayed']} for {truth}")
    rep.add("parity", f"UI numbers equal API values ({len(dump['values'])} values)", not bad, detail="; ".join(bad[:5]))


# --------------------------------------------------------------- self-test

MUTATIONS = {
    "sun elevation off by 0.01 deg": lambda r: [t.__setitem__("sun_elevation_deg", t["sun_elevation_deg"] + 0.01) for t in r["candidates"][0]["timeline"]],
    "earth azimuth off by 0.05 deg": lambda r: [t.__setitem__("earth_azimuth_deg", t["earth_azimuth_deg"] + 0.05) for t in r["candidates"][1]["timeline"]],
    "nearest-bin horizon instead of max": lambda r: [t.__setitem__("sun_horizon_deg", t["sun_horizon_deg"] - 0.2) for t in r["candidates"][0]["timeline"]],
    "illumination fraction +0.1%": lambda r: r["candidates"][2]["metrics"].__setitem__("illumination_fraction", r["candidates"][2]["metrics"]["illumination_fraction"] - 0.001),
    "longest blackout off by one sample": lambda r: r["candidates"][-1]["metrics"].__setitem__("longest_blackout_hours", r["candidates"][-1]["metrics"]["longest_blackout_hours"] + 5 / 60),
    "score drift": lambda r: r["candidates"][-1].__setitem__("score", r["candidates"][-1]["score"] + 0.01),
    "ranks swapped": lambda r: r["candidates"].__setitem__(slice(0, 2), r["candidates"][1::-1]),
    "flag flipped at one sample": lambda r: r["candidates"][0]["timeline"][100].__setitem__("earth_visible", not r["candidates"][0]["timeline"][100]["earth_visible"]),
}

FEATURE_MUTATIONS = {
    "power 5% high": lambda r: [p.__setitem__("vertical_w", p["vertical_w"] * 1.05) for p in r["candidates"][0]["power"]["series"]],
    "power from horizontal panel": lambda r: [p.__setitem__("vertical_w", p["horizontal_w"]) for p in r["candidates"][1]["power"]["series"]],
    "sunset event dropped": lambda r: r["candidates"][0].__setitem__("events", r["candidates"][0]["events"][1:]),
    "event 1 h late": lambda r: [e.__setitem__("time_utc", (parse_t(e["time_utc"]) + timedelta(hours=1)).isoformat()) for e in r["candidates"][2]["events"][:1]],
    "colour class off by one": lambda r: r["map_candidates"][0].__setitem__("suitability_class", (r["map_candidates"][0]["suitability_class"] + 1) % 4),
    "alternative breaks the constraint": lambda r: r["alternatives"][0]["metrics"].__setitem__("longest_darkness_hours", 999),
    "alternative without explanation": lambda r: r["alternatives"][0].__setitem__("reason", ""),
}


def self_test(args) -> int:
    """Plant known bugs in a real result and confirm each one is caught."""
    import copy
    ctx = Context(args)
    base = load_results(args.result)
    if not base or not base[0][1].get("candidates"):
        print("self-test needs a result JSON with candidates")
        return 2
    path, res = base[0]
    missed = []
    muts = dict(MUTATIONS)
    if res["candidates"][0].get("power"):
        muts.update(FEATURE_MUTATIONS)
    for name, mutate in muts.items():
        r = copy.deepcopy(res)
        mutate(r)
        rep = run_once(ctx, [(path, r)], args.seed, 4)
        caught = [f for f in rep.failed() if f["suite"] in ("ephemeris", "visibility", "scoring", "features")]
        print(f"{'caught' if caught else 'MISSED'}: {name}" + (f"  <- {caught[0]['suite']}: {caught[0]['check']}" if caught else ""))
        if not caught:
            missed.append(name)
    print(f"{len(muts) - len(missed)}/{len(muts)} planted faults detected")
    return 1 if missed else 0

# ------------------------------------------------------------------- driver

def run_once(ctx, results, seed, sample) -> Report:
    rep = Report()
    rng = np.random.default_rng(seed)
    suites = set(ctx.args.suites)
    if "data" in suites:
        suite_data(ctx, rep)
    if "ephemeris" in suites:
        suite_ephemeris(ctx, rep, results)
    if suites & {"visibility", "scoring", "physics", "features"}:
        suite_visibility_scoring(ctx, rep, results)
    if "cache" in suites:
        suite_cache(ctx, rep, rng, sample)
    if "metamorphic" in suites:
        suite_metamorphic(ctx, rep, rng, sample)
    if "physics" in suites:
        suite_historic(ctx, rep)
    if "features" in suites:
        suite_curated(ctx, rep)
    if ctx.args.scene_dump:
        suite_scene_parity(rep, results, ctx.args.scene_dump)
    if ctx.args.ui_dump:
        suite_ui_parity(rep, results, ctx.args.ui_dump)
    rep.rows = [r for r in rep.rows if r["suite"] in suites | {"parity"}]
    return rep


def apply_baseline(rep: Report, path: Path, update: bool):
    base = json.loads(path.read_text()) if path.exists() else {}
    for r in rep.rows:
        key = f"{r['suite']}::{r['check']}"
        if r["max_error"] is None or r["status"] != "pass":
            continue
        prior = base.get(key)
        limit = max(r["tolerance"] or 0, 2 * prior) if prior is not None else None
        if prior is not None and r["tolerance"] is not None and r["max_error"] > limit and r["max_error"] > 1e-12:
            r["status"] = "fail"
            r["detail"] += f" regressed vs baseline {prior:.3g}"
        if update:
            base[key] = r["max_error"] if prior is None else min(prior, r["max_error"]) or r["max_error"]
    if update:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(base, indent=1, sort_keys=True))


def write_report(rep: Report, out: Path, meta: dict):
    out.mkdir(parents=True, exist_ok=True)
    (out / "verify-report.json").write_text(json.dumps({"meta": meta, "summary": rep.summary(), "checks": rep.rows}, indent=1, default=str))
    lines = [f"# lumen-verify report", "", f"Run {meta['utc']} · seed {meta['seed']} · iterations {meta['iterations']}", "",
             f"**{rep.summary()['pass']} pass · {rep.summary()['fail']} fail · {rep.summary()['skip']} skip**", "",
             "| Suite | Check | Status | Max error | Tolerance | Detail |", "|---|---|---|---|---|---|"]
    for r in sorted(rep.rows, key=lambda r: ({"fail": 0, "skip": 2, "pass": 1}[r["status"]], r["suite"])):
        e = "" if r["max_error"] is None else f"{r['max_error']:.3g}"
        lines.append(f"| {r['suite']} | {r['check']} | {r['status']} | {e} | {r['tolerance'] or ''} | {r['detail']} |")
    (out / "verify-report.md").write_text("\n".join(lines) + "\n")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--kernels", default=str(ROOT / "data/raw/kernels"))
    ap.add_argument("--cap", default=str(ROOT / "data/derived/lunar-south-cap-v1"))
    ap.add_argument("--cache", nargs="*", default=None)
    ap.add_argument("--cache-start", default="2028-10-01T00:00:00Z")
    ap.add_argument("--cache-end", default="2028-10-31T00:00:00Z")
    ap.add_argument("--result", nargs="*", default=None, help="exported analysis JSON(s)")
    ap.add_argument("--curated", default=str(ROOT / "apps/web/src/data/curated-sites.json"))
    ap.add_argument("--suites", nargs="*", default=["data", "ephemeris", "visibility", "scoring", "cache",
                                                     "metamorphic", "physics", "features"])
    ap.add_argument("--seed", type=int, default=20261114)
    ap.add_argument("--sample", type=int, default=24)
    ap.add_argument("--iterate", type=int, default=1, help="clean passes required (randomised suites)")
    ap.add_argument("--baseline", default=str(ROOT / "scripts/verify/baseline.json"))
    ap.add_argument("--update-baseline", action="store_true")
    ap.add_argument("--report", default=str(ROOT / "data/cache/verify"))
    ap.add_argument("--scene-dump", help="Track B: JSON of what the 3D scene draws (window.__lumenScene.dump())")
    ap.add_argument("--ui-dump", help="Track C: JSON of displayed numbers ([data-metric] elements)")
    ap.add_argument("--self-test", action="store_true", help="plant faults and confirm detection")
    args = ap.parse_args(argv)
    if args.cache is None:
        args.cache = sorted(glob.glob(str(ROOT / "data/cache/temporal/*.npz")))[:1]
    if args.result is None:
        args.result = sorted(glob.glob(str(ROOT / "data/cache/**/regional-analysis.json"), recursive=True)
                             + glob.glob(str(ROOT / "scripts/verify/fixtures/*.json")))
    if args.self_test:
        return self_test(args)
    ctx = Context(args)
    results = load_results(args.result)
    t0 = time.time()
    combined = Report()
    seed, sample, clean = args.seed, args.sample, 0
    for it in range(1, 1000):
        rep = run_once(ctx, results if it == 1 else [], seed, sample)
        combined.rows += rep.rows if it == 1 else [r for r in rep.rows if r["suite"] in ("cache", "metamorphic")]
        if rep.failed():
            print(f"iteration {it}: {len(rep.failed())} failure(s) — stopping with reproduction")
            break
        clean += 1
        print(f"iteration {it}: clean (seed {seed}, sample {sample})")
        if clean >= args.iterate:
            break
        seed, sample = seed + 1, int(sample * 1.5)
    apply_baseline(combined, Path(args.baseline), args.update_baseline)
    meta = {"utc": datetime.now(timezone.utc).isoformat(), "seed": args.seed, "iterations": it,
            "results": args.result, "cache": args.cache, "seconds": round(time.time() - t0, 1)}
    write_report(combined, Path(args.report), meta)
    sm = combined.summary()
    for r in combined.failed():
        print(f"FAIL [{r['suite']}] {r['check']}: {r['detail']} err={r['max_error']}")
    print(f"{sm['pass']} pass, {sm['fail']} fail, {sm['skip']} skip -> {args.report}/verify-report.md")
    return 1 if sm["fail"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
