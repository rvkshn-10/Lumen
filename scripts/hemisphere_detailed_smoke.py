"""Exercise installed southern terrain, API calculation and fixed-site inspection."""

import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from time import perf_counter

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.api import candidate_search_calculation
from app.models import Coordinate, RegionSelection, SearchRequest, TimeRange
from app.services.hemisphere_terrain import sample, source
from app.services.sites import site_analysis


def main():
    output = ROOT / "data/cache/hemisphere-detailed"
    output.mkdir(parents=True, exist_ok=True)
    _, grids = source()
    probe = ROOT / "data/cache/lola-feasibility.json"
    if probe.exists():
        for item in json.loads(probe.read_text())["samples"]:
            actual = sample(
                grids, item["pixel_latitude_deg"], item["pixel_longitude_deg_east"]
            )
            np.testing.assert_allclose(actual, item["elevation_m"], atol=1e-6, rtol=0)
    report = []
    for lat, lon in [(-35, 0), (-35, -180), (-80, 90), (0, 179.99)]:
        start = datetime(2028, 10, 1, tzinfo=UTC)
        request = SearchRequest(
            region=RegionSelection(
                selector_type="circle",
                search_radius_km=1,
                center=Coordinate(latitude_deg=lat, longitude_deg_east=lon),
            ),
            time_range=TimeRange(start_utc=start, end_utc=start + timedelta(days=1)),
        )
        before = perf_counter()
        result = candidate_search_calculation(request)
        assert result["candidates"] and result["counts"]["region"] > 0
        assert all(site["latitude_deg"] <= 0 for site in result["candidates"])
        site = result["candidates"][0]
        inspection = site_analysis(site["id"], request)
        assert inspection["metrics"] == site["metrics"]
        path = output / f"search-{lat}-{lon}.json"
        path.write_text(json.dumps(result))
        row = {
            "latitude": lat,
            "longitude": lon,
            "seconds": perf_counter() - before,
            "candidates": result["counts"],
            "path": str(path),
        }
        report.append(row)
        print(json.dumps(row), flush=True)
    (output / "report.json").write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
