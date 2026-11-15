"""Resume exact 30-day window caches for selected mission circles over 24 months.

Aggregate columns are valid only for the identical start/end, never a subwindow.
Float64 is intentional: existing fractional tolerances are tighter than float32.
"""

import argparse
import calendar
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from app.services.ephemeris import body_positions
from app.services.terrain_store import TerrainStore
from app.services.tile_metrics import window_directory
from precompute_cap_window import prepare_tile
from precompute_window import utc


def windows(start, months):
    month = start.year * 12 + start.month - 1 + months
    year, index = divmod(month, 12)
    stop = start.replace(
        year=year,
        month=index + 1,
        day=min(start.day, calendar.monthrange(year, index + 1)[1]),
    )
    while start < stop:
        end = min(start + timedelta(days=30), stop)
        yield start, end
        start = end


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--kernel-root", type=Path, required=True)
    parser.add_argument("--start", type=utc, required=True)
    parser.add_argument("--months", type=int, default=24)
    parser.add_argument(
        "--region",
        nargs=3,
        type=float,
        action="append",
        required=True,
        metavar=("LAT", "LON", "RADIUS_KM"),
    )
    args = parser.parse_args()
    if not 1 <= args.months <= 24:
        parser.error("months must be between 1 and 24")
    terrain = TerrainStore(args.root)
    tiles = sorted(
        {
            tile
            for lat, lon, radius in args.region
            for tile in terrain.intersecting_tiles(lat, lon, radius)
        }
    )
    for start, end in windows(args.start, args.months):
        if start.year < 2025 or end > datetime(2036, 1, 1, tzinfo=start.tzinfo):
            parser.error("All windows must fall within 2025-2035")
        positions = body_positions(args.kernel_root, start, end, 5)
        for tile in tiles:
            terrain.load_tile(tile)
            prepare_tile(
                args.root,
                tile,
                args.kernel_root,
                start,
                end,
                positions,
                window_directory(args.root, start, end),
            )


if __name__ == "__main__":
    main()
