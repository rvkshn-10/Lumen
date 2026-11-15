"""High-resolution local terrain straight from NASA's 80 m/px LOLA south-pole DEM.

The cap overview (``terrain.json``) is a 101 x 101 grid at 2 km spacing, which is
far too coarse to look at a single landing site. This reads only the window
around the requested point from NASA PGDA ``LDEM_80S_80MPP_ADJ.TIF`` and samples
it bilinearly onto a regular grid in the same polar-stereographic frame and row
order as the overview, so the web scenes can swap one for the other.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

import numpy as np

from app.services.dataset import DataUnavailable
from app.settings import REPOSITORY_ROOT

DEM = Path(os.getenv("LUMEN_LOCAL_DEM", REPOSITORY_ROOT / "data/raw/pgda-product-90/LDEM_80S_80MPP_ADJ.TIF"))
SOURCE = "NASA PGDA LOLA LDEM_80S_80MPP_ADJ.TIF"
SOURCE_URL = "https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_80MPP_ADJ.TIF"
MAX_SIDE = 321
MIN_HALF_KM, MAX_HALF_KM = 1.0, 40.0


def local_terrain(x_m: float, y_m: float, half_km: float) -> dict:
    half_km = float(np.clip(half_km, MIN_HALF_KM, MAX_HALF_KM))
    # Snap to the source grid so nearby requests share a cached window.
    return _window(round(x_m / 80) * 80, round(y_m / 80) * 80, round(half_km * 4) / 4)


@lru_cache(maxsize=32)
def _window(x_m: float, y_m: float, half_km: float) -> dict:
    if not DEM.exists():
        raise DataUnavailable(f"The NASA LOLA 80 m DEM is not installed at {DEM}.")
    import rasterio
    from rasterio.windows import Window
    from scipy.ndimage import map_coordinates

    half = half_km * 1000
    with rasterio.open(DEM) as source:
        left, bottom, right, top = source.bounds
        x0, x1 = max(left, x_m - half), min(right, x_m + half)
        y0, y1 = max(bottom, y_m - half), min(top, y_m + half)
        if x1 - x0 < 160 or y1 - y0 < 160:
            raise DataUnavailable("That point is outside the NASA LOLA south-pole DEM.")
        transform = source.transform
        col0 = max(0, int(np.floor((x0 - transform.c) / transform.a)) - 2)
        col1 = min(source.width, int(np.ceil((x1 - transform.c) / transform.a)) + 2)
        row0 = max(0, int(np.floor((y1 - transform.f) / transform.e)) - 2)
        row1 = min(source.height, int(np.ceil((y0 - transform.f) / transform.e)) + 2)
        block = source.read(1, window=Window(col0, row0, col1 - col0, row1 - row0), masked=True)
        values = block.astype(np.float64).filled(np.nan)
        native = round(max(x1 - x0, y1 - y0) / abs(transform.a)) + 1
        side = int(min(MAX_SIDE, max(33, native)))
        xs = np.linspace(x0, x1, side)
        ys = np.linspace(y1, y0, side)  # north to south, like terrain.json
        grid_x, grid_y = np.meshgrid(xs, ys)
        col = (grid_x - transform.c) / transform.a - 0.5 - col0
        row = (grid_y - transform.f) / transform.e - 0.5 - row0
        finite = np.isfinite(values)
        if not finite.any():
            raise DataUnavailable("The NASA DEM has no samples in that window.")
        if not finite.all():
            # Nodata cells would punch holes in the mesh; fill them from the nearest real sample.
            from scipy.ndimage import distance_transform_edt

            index = distance_transform_edt(~finite, return_distances=False, return_indices=True)
            values = values[tuple(index)]
        sampled = map_coordinates(values, [row, col], order=1, mode="nearest")
    resolution = (x1 - x0) / (side - 1)
    return {
        "width": side,
        "height": side,
        "extent_m": [float(x0), float(y0), float(x1), float(y1)],
        "elevations_m": np.round(sampled.ravel(), 2).tolist(),
        "resolution_m": round(float(resolution), 2),
        "source_resolution_m": float(abs(transform.a)),
        "row_order": "north_to_south",
        "source": SOURCE,
        "source_url": SOURCE_URL,
        "crs": "Lunar south polar stereographic; central meridian 0; radius 1737400 m",
    }
