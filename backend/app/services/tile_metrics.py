"""Optional exact per-tile temporal caches, verified before they can be used."""

from __future__ import annotations

import hashlib
import inspect
import json
from collections import OrderedDict
from functools import lru_cache
from pathlib import Path
from threading import RLock

import numpy as np

from app.services import ephemeris
from app.services.search import (
    METRIC_KEYS,
    TEMPORAL_CACHE_VERSION,
    _longest_runs,
    analyze,
    analyze_batch,
)
from app.services.terrain_store import digest

_CACHE = OrderedDict()
_CACHE_LOCK = RLock()
_CACHE_BYTES = 0
_CACHE_BUDGET = 32 * 1024 * 1024


def _stamp(path):
    value = path.stat()
    return value.st_size, value.st_mtime_ns, value.st_ctime_ns


def window_directory(root: Path, start, end) -> Path:
    from datetime import UTC

    dates = [value.astimezone(UTC).isoformat() for value in (start, end)]
    key = hashlib.sha256(json.dumps(dates).encode()).hexdigest()
    return root / "window-cache" / key


@lru_cache(maxsize=4)
def _algorithm_hash(functions, source_stamp):
    del source_stamp  # Invalidates the cached inspection when the source changes.
    algorithm = "\n".join(inspect.getsource(fn) for fn in functions)
    return hashlib.sha256(algorithm.encode()).hexdigest()


@lru_cache(maxsize=4)
def _source_hash(path, stamp):
    del stamp
    return digest(path)


def cache_identity(metadata: dict, kernel_root: Path, start, end, reference_id: str) -> dict:
    functions = (analyze, analyze_batch, _longest_runs)
    source = Path(inspect.getsourcefile(analyze))
    ephemeris_source = Path(ephemeris.__file__)
    return {
        "schema_version": 1,
        "algorithm_version": TEMPORAL_CACHE_VERSION,
        "algorithm_sha256": _algorithm_hash(functions, _stamp(source)),
        "ephemeris_sha256": _source_hash(ephemeris_source, _stamp(ephemeris_source)),
        "dataset_version": metadata["dataset_version"],
        "artifacts": metadata["artifacts"],
        "scoring_reference_id": reference_id,
        "kernels": {item["file"]: item["sha256"] for item in ephemeris.load_kernels(kernel_root)},
        "start_utc": start.isoformat(),
        "end_utc": end.isoformat(),
        "step_minutes": 5,
    }


def identity_key(identity: dict) -> str:
    return hashlib.sha256(
        json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def load_tile_metrics(
    directory: Path, tile_id: str, expected_identity: dict, expected_ids: np.ndarray
) -> dict | None:
    """Return None for absent, stale or damaged optional caches; caller computes directly."""
    global _CACHE_BYTES
    try:
        manifest_path = directory / f"{tile_id}.json"
        path = directory / f"{tile_id}.npz"
        stamp = (_stamp(manifest_path), _stamp(path))
        cache_key = (str(directory.resolve()), tile_id, identity_key(expected_identity))
        with _CACHE_LOCK:
            cached = _CACHE.get(cache_key)
            if (
                cached is not None
                and cached[0] == stamp
                and np.array_equal(cached[1], expected_ids)
            ):
                _CACHE.move_to_end(cache_key)
                return dict(cached[2])
        manifest = json.loads(manifest_path.read_text())
        if manifest["identity"] != expected_identity or manifest["key"] != identity_key(
            expected_identity
        ):
            return None
        if path.stat().st_size != manifest["bytes"] or digest(path) != manifest["sha256"]:
            return None
        with np.load(path, allow_pickle=False) as archive:
            ids = archive["ids"]
            if str(archive["key"]) != manifest["key"] or not np.array_equal(ids, expected_ids):
                return None
            columns = {key: archive[key] for key in METRIC_KEYS}
        if any(
            values.shape != (len(expected_ids),) or not np.isfinite(values).all()
            for values in columns.values()
        ):
            return None
        if stamp != (_stamp(manifest_path), _stamp(path)):
            return None  # An in-flight replacement must be verified afresh.
        ids.flags.writeable = False
        for values in columns.values():
            values.flags.writeable = False
        size = ids.nbytes + sum(values.nbytes for values in columns.values())
        if size <= _CACHE_BUDGET:
            with _CACHE_LOCK:
                old = _CACHE.pop(cache_key, None)
                if old is not None:
                    _CACHE_BYTES -= old[3]
                while _CACHE and (_CACHE_BYTES + size > _CACHE_BUDGET or len(_CACHE) >= 256):
                    _, old = _CACHE.popitem(last=False)
                    _CACHE_BYTES -= old[3]
                _CACHE[cache_key] = (stamp, ids, dict(columns), size)
                _CACHE_BYTES += size
        return columns
    except (OSError, ValueError, KeyError, TypeError):
        return None
