#!/usr/bin/env python3
"""Download NASA trajectories for historic lunar landers and cache derived paths.

Every number written by this script comes from a NASA source. Nothing is
modelled, interpolated beyond the source's own representation, or invented:

* IM-1, IM-2 and Blue Ghost M1: reconstructed cruise and entry/descent/landing
  SPK kernels from the NASA PDS archive maintained by NAIF (CLPS SPICE archive).
* Chandrayaan-3 Vikram lander (Horizons ID -158): state vectors from the NASA
  JPL Horizons API.
* Moon position and orientation: JPL DE440s and the DE440 lunar orientation
  kernels already pinned in data/raw/kernels.

Missions without a NASA-published trajectory are left out; the app says so
instead of drawing a path.

Usage:  .venv/bin/python scripts/fetch_nasa_trajectories.py
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import spiceypy as spice

ROOT = Path(__file__).resolve().parents[1]
KERNELS = ROOT / "data" / "raw" / "kernels"
RAW = ROOT / "data" / "raw" / "nasa-trajectories"
OUT = ROOT / "data" / "derived" / "nasa-trajectories"
NAIF_SPK = "https://naif.jpl.nasa.gov/pub/naif/pds/pds4/clps/clps_spice/spice_kernels/spk/"
NAIF_ARCHIVE = "https://naif.jpl.nasa.gov/pub/naif/pds/pds4/clps/clps_spice/"
HORIZONS = "https://ssd.jpl.nasa.gov/api/horizons.api"
MOON_FIXED = "MOON_ME_DE440_ME421"
MAX_PATH_POINTS = 2400
MAX_DESCENT_POINTS = 1500

MISSIONS: dict[str, dict] = {
    "im-1": {
        "name": "IM-1 Odysseus (Nova-C)", "naif_id": -370011,
        "files": ["clps_to2im_im1_cru_rec_240216_240221_v01.bsp", "clps_to2im_im1_edl_rec_240222_v01.bsp",
                  "clps_to2im_im1_ls_242022_v02.bsp"],
        "edl": "clps_to2im_im1_edl_rec_240222_v01.bsp",
    },
    "im-2": {
        "name": "IM-2 Athena (Nova-C)", "naif_id": -370021,
        "files": ["clps_prime1_im2_cru_rec_250227_250306_v01.bsp", "clps_prime1_im2_edl_rec_250306_v01.bsp",
                  "clps_prime1_im2_ls_250306_v01.bsp"],
        "edl": "clps_prime1_im2_edl_rec_250306_v01.bsp",
    },
    "blue-ghost-m1": {
        "name": "Blue Ghost Mission 1", "naif_id": -2711,
        "files": ["clps_to19d_bgm1_cru_rec_250115_250302_v01.bsp", "clps_to19d_bgm1_edl_rec_250302_v01.bsp",
                  "clps_to19d_bgm1_ls_250302_v01.bsp"],
        "edl": "clps_to19d_bgm1_edl_rec_250302_v01.bsp",
    },
    # The landing time only locates the search window (ISRO, as in the site catalog);
    # touchdown itself is taken from the Horizons data, where Vikram stops moving.
    "chandrayaan-3": {"name": "Chandrayaan-3 Vikram lander", "horizons_id": "-158", "landing_window_utc": "2023-08-23T12:33:00"},
}


def log(message: str) -> None:
    print(message, flush=True)


def load_base_kernels() -> None:
    for name in ("naif0012.tls", "de440s.bsp", "moon_pa_de440_200625.bpc", "moon_de440_250416.tf"):
        spice.furnsh(str(KERNELS / name))


def download(name: str) -> Path:
    RAW.mkdir(parents=True, exist_ok=True)
    path = RAW / name
    if path.exists() and path.stat().st_size > 0:
        return path
    log(f"  downloading {name} from NASA NAIF…")
    with urllib.request.urlopen(NAIF_SPK + name, timeout=300) as response, open(path.with_suffix(".part"), "wb") as out:
        while chunk := response.read(1 << 20):
            out.write(chunk)
    path.with_suffix(".part").rename(path)
    return path


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def utc(et: float) -> str:
    return spice.et2utc(et, "ISOC", 3) + "Z"


def unix_ms(et: float) -> int:
    iso = spice.et2utc(et, "ISOC", 3)
    return int(datetime.fromisoformat(iso).replace(tzinfo=timezone.utc).timestamp() * 1000)


def coverage(path: Path, body: int) -> list[tuple[float, float]]:
    window = spice.spkcov(str(path), body)
    return [spice.wnfetd(window, i) for i in range(spice.wncard(window))]


def merge(intervals: list[tuple[float, float]]) -> list[tuple[float, float]]:
    merged: list[list[float]] = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [(a, b) for a, b in merged]


def sample_times(intervals: list[tuple[float, float]], budget: int) -> list[np.ndarray]:
    total = sum(b - a for a, b in intervals) or 1
    step = max(1.0, total / budget)
    return [np.append(np.arange(a, b, step), b) for a, b in intervals if b > a]


def enu_basis(up: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    up = up / np.linalg.norm(up)
    east = np.cross([0.0, 0.0, 1.0], up)
    east /= np.linalg.norm(east)
    north = np.cross(up, east)
    return east, north, up


def descent_from_fixed(times: np.ndarray, fixed_km: np.ndarray) -> dict:
    """Local east/north/up relative to the final (touchdown) sample, in km."""
    final = fixed_km[-1]
    east, north, up = enu_basis(final)
    relative = fixed_km - final
    enu = np.stack([relative @ east, relative @ north, relative @ up], axis=1)
    altitude = np.linalg.norm(fixed_km, axis=1) - np.linalg.norm(final)
    return {
        "t_ms": [unix_ms(t) for t in times],
        "enu_km": np.round(enu, 4).tolist(),
        "altitude_km": np.round(altitude, 4).tolist(),
        "touchdown_utc": utc(times[-1]),
        "frame": f"{MOON_FIXED} (DE440), local east/north/up at the final sample",
    }


def geocentric_segments(body: str, intervals: list[tuple[float, float]], position) -> list[dict]:
    segments = []
    for times in sample_times(intervals, MAX_PATH_POINTS):
        craft = np.array([position(t) for t in times])
        moon = np.array([spice.spkpos("MOON", t, "J2000", "NONE", "EARTH")[0] for t in times])
        segments.append({
            "t_ms": [unix_ms(t) for t in times],
            "spacecraft_km": np.round(craft, 1).tolist(),
            "moon_km": np.round(moon, 1).tolist(),
        })
    return segments


def spk_mission(key: str, mission: dict) -> dict:
    paths = [download(name) for name in mission["files"]]
    for path in paths:
        spice.furnsh(str(path))
    body = mission["naif_id"]
    intervals = merge([interval for path in paths for interval in coverage(path, body)])
    log(f"  coverage: {[(utc(a), utc(b)) for a, b in intervals]}")
    segments = geocentric_segments(str(body), intervals,
                                   lambda t: spice.spkpos(str(body), t, "J2000", "NONE", "EARTH")[0])
    edl_path = RAW / mission["edl"]
    edl_intervals = merge(coverage(edl_path, body))
    times = np.concatenate(sample_times(edl_intervals, MAX_DESCENT_POINTS))
    fixed = np.array([spice.spkpos(str(body), t, MOON_FIXED, "NONE", "MOON")[0] for t in times])
    return {
        "segments": segments,
        "descent": descent_from_fixed(times, fixed),
        "coverage": [[utc(a), utc(b)] for a, b in intervals],
        "source": {
            "name": "NASA PDS / NAIF CLPS SPICE archive (reconstructed trajectory kernels)",
            "url": NAIF_ARCHIVE,
            "naif_id": body,
            "files": [{"file": p.name, "url": NAIF_SPK + p.name, "sha256": sha256(p)} for p in paths],
        },
    }


def horizons(params: dict) -> str:
    query = {"format": "text", "MAKE_EPHEM": "YES", "EPHEM_TYPE": "VECTORS", "CENTER": "'500@399'",
             "REF_PLANE": "FRAME", "REF_SYSTEM": "ICRF", "OUT_UNITS": "KM-S", "VEC_TABLE": "1",
             "CSV_FORMAT": "YES", "OBJ_DATA": "NO", **params}
    url = HORIZONS + "?" + urllib.parse.urlencode(query)
    with urllib.request.urlopen(url, timeout=300) as response:
        return response.read().decode()


MONTHS = {m: i for i, m in enumerate(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], 1)}


def horizons_span(command: str) -> tuple[str, str]:
    """Read the object's available span from Horizons' own out-of-range messages."""
    def bound(start: str, stop: str, word: str) -> str:
        text = horizons({"COMMAND": f"'{command}'", "START_TIME": f"'{start}'", "STOP_TIME": f"'{stop}'", "STEP_SIZE": "'1 d'"})
        match = re.search(word + r" A\.D\. (\d{4})-([A-Z]{3})-(\d{2}) (\d{2}:\d{2}:\d{2}\.\d+)", text)
        if not match:
            raise RuntimeError(f"Horizons did not report a {word!r} limit:\n{text[-800:]}")
        year, month, day, clock = match.groups()
        return f"{year}-{MONTHS[month]:02d}-{day} {clock} TDB"
    return bound("1990-01-01", "1990-01-02", "prior to"), bound("2099-01-01", "2099-01-02", "after")


def parse_vectors(text: str) -> tuple[np.ndarray, np.ndarray]:
    if "$$SOE" not in text:
        raise RuntimeError("Horizons returned no ephemeris table:\n" + text[-1500:])
    body = text.split("$$SOE")[1].split("$$EOE")[0]
    rows = [line.split(",") for line in body.strip().splitlines() if line.strip()]
    ets = np.array([(float(row[0]) - 2451545.0) * 86400.0 for row in rows])  # JD TDB → TDB seconds past J2000
    xyz = np.array([[float(row[2]), float(row[3]), float(row[4])] for row in rows])
    return ets, xyz


def horizons_mission(key: str, mission: dict) -> dict:
    command = mission["horizons_id"]
    start, stop = horizons_span(command)
    # Stay just inside the reported span: Horizons rejects requests at its exact limits.
    start_et, stop_et = spice.str2et(start) + 60, spice.str2et(stop) - 60
    log(f"  Horizons span: {utc(start_et)} → {utc(stop_et)}")
    def tdb(et: float) -> str:
        return spice.timout(et, "YYYY-MM-DD HR:MN:SC.### ::TDB")
    def fetch_tdb(a: float, b: float, intervals: int):
        text = horizons({"COMMAND": f"'{command}'", "START_TIME": f"'{tdb(a)} TDB'", "STOP_TIME": f"'{tdb(b)}'",  # Horizons takes the time scale from START only
                         "STEP_SIZE": f"'{intervals}'"})
        return parse_vectors(text)
    # Find touchdown in the data: fine samples around the reported landing, then the
    # first sample after which the Moon-fixed position stays within 20 m.
    hint = spice.str2et(mission["landing_window_utc"])
    d_ets, d_craft = fetch_tdb(max(start_et, hint - 7200), min(stop_et, hint + 1800), 1200)
    fixed = []
    for t, r in zip(d_ets, d_craft):
        moon_geo = spice.spkpos("MOON", t, "J2000", "NONE", "EARTH")[0]
        fixed.append(spice.pxform("J2000", MOON_FIXED, t) @ (r - moon_geo))
    fixed = np.array(fixed)
    still = np.linalg.norm(fixed - fixed[-1], axis=1) < .02
    moving = np.where(~still)[0]
    if not len(moving) or moving[-1] + 1 >= len(fixed):
        raise RuntimeError("Could not find a stationary touchdown in the Horizons data.")
    touchdown = moving[-1] + 1
    d_ets, fixed = d_ets[:touchdown + 1], fixed[:touchdown + 1]
    stop_et = d_ets[-1]
    ets, craft = fetch_tdb(start_et, stop_et, MAX_PATH_POINTS)
    moon = np.array([spice.spkpos("MOON", t, "J2000", "NONE", "EARTH")[0] for t in ets])
    segments = [{"t_ms": [unix_ms(t) for t in ets], "spacecraft_km": np.round(craft, 1).tolist(),
                 "moon_km": np.round(moon, 1).tolist()}]
    return {
        "segments": segments,
        "descent": descent_from_fixed(d_ets, np.array(fixed)),
        "coverage": [[utc(start_et), utc(stop_et)]],
        "source": {
            "name": "NASA JPL Horizons (state vectors, ICRF, Earth-centered)",
            "url": "https://ssd.jpl.nasa.gov/horizons/",
            "horizons_id": command,
            "query": "EPHEM_TYPE=VECTORS CENTER=500@399 REF_SYSTEM=ICRF",
            "note": "Descent converted to the Moon-fixed frame with JPL DE440 kernels. Horizons ICRF and SPICE J2000 differ by milliarcseconds.",
        },
    }


def main(only: list[str]) -> int:
    load_base_kernels()
    OUT.mkdir(parents=True, exist_ok=True)
    index = {}
    failures = 0
    for key, mission in MISSIONS.items():
        if only and key not in only:
            continue
        log(f"{key}: {mission['name']}")
        try:
            data = spk_mission(key, mission) if "naif_id" in mission else horizons_mission(key, mission)
        except Exception as exc:  # report and continue; never write a partial or synthetic file
            failures += 1
            log(f"  FAILED: {exc}")
            continue
        payload = {"id": key, "name": mission["name"], "frame": "J2000 (ICRF), Earth-centered, kilometres",
                   "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"), **data}
        (OUT / f"{key}.json").write_text(json.dumps(payload, separators=(",", ":")))
        points = sum(len(s["t_ms"]) for s in data["segments"])
        index[key] = {"name": mission["name"], "points": points, "descent_points": len(data["descent"]["t_ms"]),
                      "coverage": data["coverage"], "source": data["source"]["name"]}
        log(f"  wrote {points} path points, {len(data['descent']['t_ms'])} descent points; touchdown {data['descent']['touchdown_utc']}")
    existing = json.loads((OUT / "index.json").read_text()) if (OUT / "index.json").exists() else {}
    existing.update(index)
    (OUT / "index.json").write_text(json.dumps(existing, indent=2))
    log("DONE" if not failures else f"DONE with {failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
