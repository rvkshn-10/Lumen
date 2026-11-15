"""Whole-southern-hemisphere survey on a declared, equal-area latitude lattice.

Candidate spacing is regional (~150 km), while terrain at each candidate uses
the verified 118 m LOLA source for slope/roughness, with 2 km global horizons.
This does not claim to find the optimum among all 500 m surface locations.
"""

import hashlib
import json
from functools import lru_cache

import numpy as np

from app.services.dataset import DataUnavailable
from app.services.hemisphere_terrain import RADIUS, ROOT, source
from app.services.terrain_store import artifact_stamp, digest

VERSION = "southern-hemisphere-survey-5deg-v2"


def grid():
    latitude, longitude = [], []
    for lat in np.arange(-87.5, 0, 5):
        count = max(1, round(72 * np.cos(np.deg2rad(lat))))
        latitude.extend([float(lat)] * count)
        longitude.extend((-180 + (np.arange(count) + 0.5) * 360 / count).tolist())
    return np.asarray(latitude), np.asarray(longitude)


def fingerprint(metadata):
    return hashlib.sha256(json.dumps(metadata, sort_keys=True).encode()).hexdigest()


@lru_cache(maxsize=2)
def _load(stamps, source_key):
    del stamps
    directory = ROOT / "survey"
    manifest = json.loads((directory / "manifest.json").read_text())
    path = directory / "terrain.npz"
    if (
        manifest["version"] != VERSION
        or manifest["source_fingerprint"] != source_key
        or path.stat().st_size != manifest["bytes"]
        or digest(path) != manifest["sha256"]
    ):
        raise DataUnavailable(
            "Hemisphere survey integrity failed; rebuild it from installed terrain"
        )
    with np.load(path, allow_pickle=False) as archive:
        arrays = {key: archive[key] for key in archive.files}
    lat, lon = grid()
    if not np.array_equal(arrays["lat_deg"], lat) or not np.array_equal(arrays["lon_deg"], lon):
        raise DataUnavailable("Unexpected hemisphere survey lattice")
    for key in ("elevation_m", "slope_deg", "roughness_m", "x_m", "y_m"):
        if arrays[key].shape != lat.shape or not np.isfinite(arrays[key]).all():
            raise DataUnavailable("Invalid survey terrain column")
    for key in ("horizons_deg", "blocker_distance_m"):
        if arrays[key].shape != (len(lat), 72) or not np.isfinite(arrays[key]).all():
            raise DataUnavailable("Invalid survey horizons")
    expected_ids = np.array([f"hemi-survey-{i:04d}" for i in range(len(lat))])
    if not np.array_equal(arrays["ids"], expected_ids):
        raise DataUnavailable("Invalid survey site IDs")
    for values in arrays.values():
        values.flags.writeable = False
    return manifest, arrays


def load():
    try:
        metadata, _ = source()
        directory = ROOT / "survey"
        stamps = tuple(
            artifact_stamp(p)
            for p in (directory / "manifest.json", directory / "terrain.npz")
        )
        from app.global_api import global_grid

        global_metadata, _ = global_grid()
        manifest, arrays = _load(
            stamps, fingerprint({"detailed": metadata, "global": global_metadata})
        )
        return {
            "dataset_version": VERSION,
            "coordinate_frame": "MOON_ME_DE440_ME421",
            "reference_radius_m": RADIUS,
            "candidate_count": len(arrays["ids"]),
            "candidate_spacing_m": RADIUS * np.pi / 180 * 5,
            "coverage": {
                "description": "Whole southern hemisphere survey, approximately 150 km candidate spacing"
            },
            "artifacts": {"survey_sha256": manifest["sha256"]},
            "source": metadata,
            "global_horizon_source": global_metadata,
            "observer_elevation_source": "coarse global LOLA grid, consistent with survey horizon geometry",
            "terrain_metric_source": "118 m LOLA DEM for 500 m slope and roughness",
            "horizon_azimuth_step_deg": 5,
            "horizon_maximum_range_m": 200000,
            "horizon_radial_step_m": 2000,
            "horizon_terrain_resolution_m": 1900,
            "scoring_reference": {
                "id": "hemisphere-terrain-fixed-v1",
                "method": "fixed hemisphere terrain bounds; clipped linear utility",
                "bounds": {
                    "slope_deg": [0, 30],
                    "roughness_m": [0, 100],
                    "elevation_m": [-9000, 9000],
                },
            },
        }, arrays
    except (OSError, ValueError, KeyError) as exc:
        raise DataUnavailable(
            "Prepare the hemisphere survey before ranking the entire hemisphere"
        ) from exc


def ready():
    try:
        load()
        return True
    except DataUnavailable:
        return False
