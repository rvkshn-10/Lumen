"""Bridge the planning APIs to verified tiles while retaining the legacy reader."""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

import numpy as np

from app.services.dataset import DataUnavailable, dataset
from app.services.terrain_store import ROW_COLUMNS, SCALAR_COLUMNS, TerrainStore, digest


def is_tiled(root: Path) -> bool:
    return (root / "catalog.json").exists()


@lru_cache(maxsize=2)
def store(root: Path) -> TerrainStore:
    return TerrainStore(root, max_cache_bytes=int(os.getenv("LUMEN_TILE_CACHE_BYTES", "33554432")))


def release_metadata(root: Path) -> dict:
    if not is_tiled(root):
        return dataset(root)[0]
    catalog = store(root).catalog()
    try:
        metadata = json.loads((root / "metadata.json").read_text())
        if (
            metadata["catalog_sha256"] != catalog["catalog_sha256"]
            or metadata["scoring_reference"] != catalog["scoring_reference"]
            or metadata["candidate_count"] != catalog["verification"]["verified_candidates"]
        ):
            raise ValueError("Release metadata does not match the frozen catalog")
        return metadata
    except (OSError, KeyError, ValueError) as exc:
        raise DataUnavailable(f"Cap release unavailable: {exc}") from exc


def read_asset(root: Path, name: str) -> dict:
    metadata = release_metadata(root)
    try:
        artifact = metadata["artifacts"][name]
        path = root / name
        if path.stat().st_size != artifact["bytes"] or digest(path) != artifact["sha256"]:
            raise ValueError("Asset integrity failed")
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, KeyError, ValueError) as exc:
        raise DataUnavailable(f"Prepared layer unavailable: {name}") from exc


def load_area(root: Path, region, *, scalar_only: bool = False) -> tuple[dict, dict]:
    if not is_tiled(root):
        return dataset(root)
    terrain = store(root)
    metadata = release_metadata(root)
    if region.selector_type == "full_supported_region":
        tile_ids = [tile["id"] for tile in terrain.catalog()["tiles"]]
        columns = SCALAR_COLUMNS if scalar_only else ROW_COLUMNS
        chunks = {key: [] for key in columns}
        for tile_id in tile_ids:
            arrays = (
                terrain.load_scalar_tile(tile_id) if scalar_only else terrain.load_tile(tile_id)
            )
            for key, pieces in chunks.items():
                pieces.append(arrays[key].copy())
        arrays = {key: np.concatenate(pieces) for key, pieces in chunks.items()}
        del chunks  # Release tile copies before allocating the sorted result.
        order = np.argsort(arrays["ids"], kind="stable")
        arrays = {key: values[order] for key, values in arrays.items()}
        arrays["horizon_azimuth_deg"] = np.arange(0, 360, 5, dtype=np.float32)
    else:
        center = region.center
        tile_ids = terrain.intersecting_tiles(
            center.latitude_deg, center.longitude_deg_east, region.search_radius_km
        )
        arrays = terrain.load_area(
            center.latitude_deg, center.longitude_deg_east, region.search_radius_km
        )
    return {**metadata, "used_tile_ids": tile_ids}, arrays


def load_site(root: Path, site_id: str, neighbor_radius_m: float = 0) -> tuple[dict, dict]:
    if not is_tiled(root):
        return dataset(root)
    terrain = store(root)
    point = terrain.site(site_id)
    if neighbor_radius_m > 0:
        arrays = terrain.load_area(
            float(point["lat_deg"][0]), float(point["lon_deg"][0]), neighbor_radius_m / 1000 * 1.001
        )
    else:
        arrays = point
    return release_metadata(root), arrays


def selected_metrics(
    root: Path,
    metadata: dict,
    arrays: dict,
    indices,
    kernel_root: Path,
    start,
    end,
    *,
    columnar: bool = False,
):
    # Import lazily: the scientific engine also consumes this repository.
    from app.services.ephemeris import body_positions
    from app.services.metric_columns import MetricRows
    from app.services.search import METRIC_KEYS, evaluate_metrics
    from app.services.tile_metrics import cache_identity, load_tile_metrics, window_directory

    terrain = store(root)
    wanted_ids = arrays["ids"][indices]
    order = np.argsort(wanted_ids, kind="stable")
    ordered_ids = wanted_ids[order]
    output = {key: np.full(len(indices), np.nan, dtype=np.float64) for key in METRIC_KEYS}
    exact_demo = (
        start.isoformat() == "2028-10-01T00:00:00+00:00"
        and end.isoformat() == "2028-10-31T00:00:00+00:00"
    )
    directory = root / "demo-cache" if exact_demo else window_directory(root, start, end)
    if directory.exists() or exact_demo:
        for tile_id in metadata["used_tile_ids"]:
            tile_ids = terrain.load_ids(tile_id)
            tile_metadata = json.loads((root / tile_id / "metadata.json").read_text())
            identity = cache_identity(
                tile_metadata, kernel_root, start, end, metadata["scoring_reference"]["id"]
            )
            columns = load_tile_metrics(directory, tile_id, identity, tile_ids)
            if columns is None:
                if not exact_demo:
                    continue
                raise DataUnavailable(
                    "The exact full-region demo cache is unavailable; prepare it before retrying"
                )
            if len(indices):
                positions = np.searchsorted(ordered_ids, tile_ids)
                present = positions < len(ordered_ids)
                present &= ordered_ids[np.minimum(positions, len(ordered_ids) - 1)] == tile_ids
                destinations = order[positions[present]]
                for key in METRIC_KEYS:
                    output[key][destinations] = columns[key][present]
    missing = np.flatnonzero(np.isnan(output[METRIC_KEYS[0]]))
    if exact_demo and len(missing):
        raise DataUnavailable("Exact demo cache did not account for every selected site")
    if len(missing):
        times, sun, earth = body_positions(kernel_root, start, end, 5)
        for offset in range(0, len(missing), 32):
            positions = missing[offset : offset + 32]
            computed = evaluate_metrics(arrays, np.asarray(indices)[positions], times, sun, earth)
            for key in METRIC_KEYS:
                output[key][positions] = [row[key] for row in computed]
    rows = MetricRows(output)
    return rows if columnar else tuple(rows)
