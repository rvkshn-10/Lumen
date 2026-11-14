"""Build the curated picker from official region polygons and cited landing records.

Download A3_9regions-lonlat-simplified.zip from the USGS release below; this
offline builder never infers a touchdown point from an Artemis region.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import zipfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
USGS = "https://www.sciencebase.gov/catalog/item/671a6fa8d34efed5620f89f8"
NASA_REGIONS = "https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/"
NASA_LOCATIONS = "https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_artifact_impacts.html"
APOLLO = "https://www.nasa.gov/wp-content/uploads/static/history/SP-4029/Apollo_18-27_LM_Lunar_Landing.htm"
SURVEYOR = "https://nssdc.gsfc.nasa.gov/planetary/lunar/surveyor.html"
LUNA = "https://www.lpi.usra.edu/lunar/missions/luna/"

# NSSDCA/LROC coordinates use planetocentric latitude, east-positive longitude.
# Seconds reflect the cited source's precision, rather than fabricated precision.
HISTORIC = [
    ("apollo-11", "Apollo 11", .67416, 23.47314, "1969-07-20T20:17:40Z", APOLLO, 1),
    ("apollo-12", "Apollo 12", -3.0128, -23.4219, "1969-11-19T06:54:36Z", APOLLO, 1),
    ("apollo-14", "Apollo 14", -3.64589, -17.47194, "1971-02-05T09:18:13Z", APOLLO, 1),
    ("apollo-15", "Apollo 15", 26.13239, 3.63330, "1971-07-30T22:16:29Z", APOLLO, 1),
    ("apollo-16", "Apollo 16", -8.9734, 15.5011, "1972-04-21T02:23:35Z", APOLLO, 1),
    ("apollo-17", "Apollo 17", 20.1911, 30.7723, "1972-12-11T19:54:58Z", APOLLO, 1),
    ("luna-9", "Luna 9", 7.13, -64.37, "1966-02-03T18:45:30Z",
     "https://science.nasa.gov/wp-content/uploads/2023/09/DSC_monograph24.pdf", 1),
    ("luna-16", "Luna 16", -.5137, 56.3638, "1970-09-20T05:18:00Z", LUNA, 60),
    ("luna-17", "Luna 17", 38.23764, -35.00163, "1970-11-17T03:47:00Z", LUNA, 60),
    ("luna-24", "Luna 24", 12.7142, 62.2129, "1976-08-18T06:36:00Z",
     "https://www.nasa.gov/wp-content/uploads/2018/09/beyond-earth-tagged.pdf", 60),
    ("surveyor-1", "Surveyor 1", -2.4745, -43.3398, "1966-06-02T06:17:36Z", SURVEYOR, 1),
    ("surveyor-3", "Surveyor 3", -3.0162, -23.4180, "1967-04-20T00:04:53Z", SURVEYOR, 1),
    ("surveyor-5", "Surveyor 5", 1.4551, 23.1943, "1967-09-11T00:46:44Z", SURVEYOR, 1),
    ("surveyor-6", "Surveyor 6", .4742, -1.4275, "1967-11-10T01:01:06Z", SURVEYOR, 1),
    ("surveyor-7", "Surveyor 7", -40.9812, -11.5127, "1968-01-10T01:05:36Z", SURVEYOR, 1),
    ("change-3", "Chang'e 3", 44.1214, -19.5117, "2013-12-14T13:11:00Z",
     "https://iaaras.ru/en/observations/sc/change3/", 60),
    ("change-4", "Chang'e 4", -45.4561, 177.5885, "2019-01-03T02:26:00Z",
     "https://nssdc.gsfc.nasa.gov/nmc/spacecraft/display.action?id=2018-103A", 60),
    ("change-5", "Chang'e 5", 43.0576, -51.9161, "2020-12-01T15:11:00Z",
     "https://lroc.im-ldi.com/images/1172", 60),
    ("change-6", "Chang'e 6", -41.6385, -153.9852, "2024-06-01T22:23:00Z",
     "https://nssdc.gsfc.nasa.gov/nmc/spacecraft/display.action?id=CHANG-E-6", 60),
    ("chandrayaan-3", "Chandrayaan-3", -69.3741, 32.32, "2023-08-23T12:33:00Z",
     "https://www.isro.gov.in/Chandrayaan3.html", 60),
    ("slim", "SLIM", -13.3160, 25.2510, "2024-01-19T15:20:00Z",
     "https://global.jaxa.jp/press/2024/01/20240120-1_e.html", 60),
    ("im-1", "IM-1 / Odysseus", -80.13, 1.44, "2024-02-22T23:23:00Z",
     "https://science.nasa.gov/lunar-science/clps-deliveries/im-1/", 60),
    ("blue-ghost-m1", "Blue Ghost M1", 18.562, 61.810, "2025-03-02T08:34:00Z",
     "https://science.nasa.gov/lunar-science/clps-deliveries/to-19d/", 60),
    ("im-2", "IM-2 / Athena", -84.7906, 29.1957, "2025-03-06T17:28:00Z",
     "https://ntrs.nasa.gov/api/citations/20260003150/downloads/MSolo%20PRIME-1%20overview%20and%20results%20-%20LSSW.pdf", 60),
]


def build(archive: Path):
    with zipfile.ZipFile(archive) as bundle:
        geo = json.loads(bundle.read("A3_9regions-lonlat-simplified.geojson"))
    sites = []
    for feature in sorted(geo["features"], key=lambda row: row["properties"]["Region"]):
        name = feature["properties"]["Region"]
        corners = np.deg2rad(feature["geometry"]["coordinates"][0][:-1])
        lon, lat = corners[:, 0], corners[:, 1]
        vector = np.mean(np.array([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon),
                                   np.sin(lat)]), axis=1)
        vector /= np.linalg.norm(vector)
        sites.append({"id": "artemis-" + name.lower().replace(" ", "-"), "name": name,
                      "kind": "artemis_region", "latitude_deg": float(np.rad2deg(np.arcsin(vector[2]))),
                      "longitude_deg_east": float(np.rad2deg(np.arctan2(vector[1], vector[0]))),
                      "analysis": "coarse", "source_url": NASA_REGIONS,
                      "coordinate_source_url": USGS,
                      "blurb": "One of NASA's nine October 2024 candidate regions. Approximate region center, not a selected touchdown site.",
                      "coordinate_definition": "normalized mean of USGS polygon corner unit vectors"})
    for identifier, name, lat, lon, time, source, precision in HISTORIC:
        sites.append({"id": identifier, "name": name, "kind": "historic", "latitude_deg": lat,
                      "longitude_deg_east": lon, "landing_utc": time, "analysis": "coarse",
                      "source_url": source, "coordinate_source_url": NASA_LOCATIONS,
                      "landing_time_precision_seconds": precision,
                      "blurb": ("Reported approximate location; the Luna 9 lander has not been conclusively located. "
                                if identifier == "luna-9" else "")
                               + "Replay uses global coarse elevation and a flat horizon."})
    sites.append({"id": "shackleton-connecting-ridge", "name": "Shackleton connecting ridge (C1)",
                  "kind": "feature", "latitude_deg": -89.4398, "longitude_deg_east": -137.17,
                  "analysis": "coarse",
                  "source_url": "https://ntrs.nasa.gov/api/citations/20170007365/downloads/20170007365.pdf",
                  "blurb": "Published two-meter observer location C1, Table 2; not an IAU feature center or a certified landing site."})
    features = json.loads((ROOT / "data/derived/pgda-demo-v1/features.json").read_text())
    for feature in features["features"]:
        sites.append({"id": feature["id"], "name": feature["name"], "kind": "feature",
                      "latitude_deg": feature["latitude_deg"],
                      "longitude_deg_east": feature["longitude_deg_east"], "analysis": "coarse",
                      "source_url": feature["source_url"],
                      "blurb": "IAU-approved feature center; not a surveyed landing point. Verify prepared coverage before detailed analysis."})
    return {"version": "curated-sites-2026-11-14", "sites": sites,
            "provenance": {"regions_source": USGS,
                           "regions_archive_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                           "features_source_sha256": features["source"]["sha256"],
                           "historical_coordinates": NASA_LOCATIONS,
                           "coverage_policy": "Curated coordinates default to coarse; compare resolves exact prepared grid sites to detailed."}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--regions", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "apps/web/src/data/curated-sites.json")
    args = parser.parse_args()
    catalog = build(args.regions)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {len(catalog['sites'])} cited curated locations")


if __name__ == "__main__":
    main()
