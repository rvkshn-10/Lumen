"""Optional checksum-verified NPY derivatives of immutable release archives."""

import json
from pathlib import Path

import numpy as np


def load_mapped(directory: Path, source_sha256: str, keys):
    from app.services.terrain_store import digest

    try:
        manifest = json.loads((directory / "manifest.json").read_text())
        if manifest["source_sha256"] != source_sha256:
            return None
        arrays = {}
        for key in keys:
            path = directory / f"{key}.npy"
            entry = manifest["columns"][key]
            if path.stat().st_size != entry["bytes"] or digest(path) != entry["sha256"]:
                return None
            arrays[key] = np.load(path, mmap_mode="r", allow_pickle=False)
        return arrays
    except (OSError, ValueError, KeyError, TypeError):
        return None


def prepare_mapped(source: Path, directory: Path):
    from app.services.terrain_store import digest

    source_hash = digest(source)
    directory.mkdir(parents=True, exist_ok=True)
    columns = {}
    with np.load(source, allow_pickle=False) as archive:
        for key in archive.files:
            if not key.isidentifier():
                raise ValueError("Invalid array name")
            path = directory / f"{key}.npy"
            temporary = path.with_suffix(".partial.npy")
            np.save(temporary, archive[key], allow_pickle=False)
            temporary.replace(path)
            columns[key] = {"bytes": path.stat().st_size, "sha256": digest(path)}
    if digest(source) != source_hash:
        raise ValueError("Source changed while preparing mapped tile")
    temporary = directory / "manifest.partial.json"
    temporary.write_text(json.dumps({"source_sha256": source_hash, "columns": columns}))
    temporary.replace(directory / "manifest.json")
