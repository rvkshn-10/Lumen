"""Precompute resumable whole-hemisphere survey terrain; publish only complete data."""

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from app.global_api import global_grid, sample_global
from app.services.hemisphere_survey import VERSION, fingerprint, grid
from app.services.hemisphere_terrain import RADIUS, ROOT, destination, sample, source
from app.services.terrain_store import digest


def survey_terrain(grids, lat, lon, global_values):
    elevation = sample(grids, lat, lon)
    offsets = np.array([(x, y) for y in (-250, 0, 250) for x in (-250, 0, 250)])
    dlat, dlon = destination(
        lat[:, None],
        lon[:, None],
        np.arctan2(offsets[:, 0], offsets[:, 1]),
        np.hypot(offsets[:, 0], offsets[:, 1]),
    )
    z = sample(grids, dlat, dlon)
    slope = np.rad2deg(
        np.arctan(np.hypot((z[:, 5] - z[:, 3]) / 500, (z[:, 7] - z[:, 1]) / 500))
    )
    design = np.column_stack((offsets, np.ones(9)))
    roughness = np.sqrt(
        np.mean((z - z @ np.linalg.pinv(design).T @ design.T) ** 2, axis=1)
    )
    # Use a consistent coarse observer elevation with the coarse horizon DEM.
    # Detailed refinement uses the higher-resolution DEM for both instead.
    horizon_height = sample_global(global_values, lat, lon)
    distances = np.arange(2000, 200001, 2000)
    bearing = np.deg2rad(np.arange(0, 360, 5))[None, :, None]
    raylat, raylon = destination(
        lat[:, None, None], lon[:, None, None], bearing, distances
    )
    heights = sample_global(global_values, raylat, raylon)
    angle = distances / RADIUS
    el = np.rad2deg(
        np.arctan2(
            (RADIUS + heights) * np.cos(angle)
            - (RADIUS + horizon_height[:, None, None] + 2),
            (RADIUS + heights) * np.sin(angle),
        )
    )
    j = np.argmax(el, axis=2)
    # Temporal direction must use the same observer height as horizon geometry.
    return (
        horizon_height,
        slope,
        roughness,
        np.take_along_axis(el, j[:, :, None], axis=2)[:, :, 0],
        distances[j],
        elevation,
    )


def main():
    metadata, grids = source()
    global_metadata, global_values = global_grid()
    source_key = fingerprint({"detailed": metadata, "global": global_metadata})
    lat, lon = grid()
    output = ROOT / "survey"
    parts = output / f"{VERSION}-{source_key}"
    parts.mkdir(parents=True, exist_ok=True)
    columns = {
        key: []
        for key in (
            "elevation_m",
            "slope_deg",
            "roughness_m",
            "horizons_deg",
            "blocker_distance_m",
            "terrain_elevation_m",
        )
    }
    for offset in range(0, len(lat), 16):
        path = parts / f"{offset:04d}.npz"
        valid = False
        if path.exists() and path.with_suffix(".sha256").exists():
            valid = digest(path) == path.with_suffix(".sha256").read_text()
        if not valid:
            values = survey_terrain(
                grids,
                lat[offset : offset + 16],
                lon[offset : offset + 16],
                global_values,
            )
            temporary = path.with_suffix(".partial.npz")
            np.savez_compressed(temporary, **dict(zip(columns, values, strict=True)))
            temporary.replace(path)
            path.with_suffix(".sha256").write_text(digest(path))
        with np.load(path, allow_pickle=False) as archive:
            for key, values in columns.items():
                values.append(archive[key])
        print(
            f"Prepared survey locations {min(offset + 16, len(lat))}/{len(lat)}",
            flush=True,
        )
    rho = 2 * RADIUS * np.tan(np.pi / 4 + np.deg2rad(lat) / 2)
    path = output / "terrain.npz"
    temporary = output / "terrain.partial.npz"
    np.savez_compressed(
        temporary,
        ids=np.array([f"hemi-survey-{i:04d}" for i in range(len(lat))]),
        lat_deg=lat,
        lon_deg=lon,
        x_m=rho * np.sin(np.deg2rad(lon)),
        y_m=rho * np.cos(np.deg2rad(lon)),
        horizon_azimuth_deg=np.arange(0, 360, 5),
        **{key: np.concatenate(values) for key, values in columns.items()},
    )
    temporary.replace(path)
    manifest = {
        "version": VERSION,
        "source_fingerprint": source_key,
        "candidate_count": len(lat),
        "sha256": digest(path),
        "bytes": path.stat().st_size,
    }
    temporary = output / "manifest.partial.json"
    temporary.write_text(json.dumps(manifest, indent=2) + "\n")
    temporary.replace(output / "manifest.json")


if __name__ == "__main__":
    main()
