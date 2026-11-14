"""Export real backend results for the independent Track A verification gate.

Run after prepare:all-data. This producer imports the app; the checker in
scripts/verify remains entirely independent and never imports backend/app.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "data/cache/track-a")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(ROOT / "backend"))
    from app.models import CompareRequest, RegionSelection, SearchRequest
    from app.services.repository import is_tiled, load_area, load_site, selected_metrics
    from app.services.search import METRIC_KEYS, search
    from app.services.sites import site_analysis
    from app.settings import settings
    from app.v2_api import (
        ReplayRequest,
        compare_calculation,
        metrics_calculation,
        replay_calculation,
    )

    if not is_tiled(settings.data_root):
        raise SystemExit("Install the verified full-cap release before exporting the Track A gate.")

    def save(name, result):
        (args.output / name).write_text(json.dumps(result, separators=(",", ":"), allow_nan=False), encoding="utf-8")

    mission = SearchRequest(region={"selector_type": "full_supported_region"},
        time_range={"start_utc": "2028-10-01T00:00:00Z", "end_utc": "2028-10-31T00:00:00Z"},
        hard_constraints={"maximum_slope_deg": 10, "minimum_earth_visibility_fraction": .5})
    result = search(mission)
    save("cap-analysis.json", result)
    compare = CompareRequest(sites=[{"site_id": c["id"]} for c in reversed(result["candidates"][:4])],
                             **mission.model_dump(exclude={"region"}))
    save("compare.json", compare_calculation(compare))
    save("replay-apollo-12.json", replay_calculation("apollo-12", ReplayRequest()))
    fixture = json.loads((ROOT / "scripts/verify/fixtures/contract-v2.json").read_text())
    failed_id = fixture["alternatives"][0]["for_site"]
    _, point = load_site(settings.data_root, failed_id)
    failed_mission = SearchRequest.model_validate(fixture["request"])
    failed_mission.region = RegionSelection(selector_type="circle", search_radius_km=5,
        center={"latitude_deg": float(point["lat_deg"][0]), "longitude_deg_east": float(point["lon_deg"][0])})
    save("failed-site.json", site_analysis(failed_id, failed_mission))
    metadata, arrays = load_area(settings.data_root, mission.region)
    rows = selected_metrics(settings.data_root, metadata, arrays, np.arange(len(arrays["ids"])),
                            settings.kernel_root, mission.time_range.start_utc, mission.time_range.end_utc)
    np.savez_compressed(args.output / "cap-temporal.npz", ids=arrays["ids"],
                         **{key: np.array([row[key] for row in rows]) for key in METRIC_KEYS})
    save("metrics-layer.json", metrics_calculation(mission))
    print(f"Exported {len(arrays['ids']):,} verified cap sites and live V2 results to {args.output}")


if __name__ == "__main__":
    main()
