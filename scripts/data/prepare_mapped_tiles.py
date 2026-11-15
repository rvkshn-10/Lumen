"""Prepare optional mmap derivatives without modifying release manifests or archives."""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from app.services.mapped_tiles import prepare_mapped
from app.services.terrain_store import TerrainStore


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    store = TerrainStore(args.root)
    for tile in store.catalog()["tiles"]:
        store.load_tile(tile["id"])  # Verify original release before deriving columns.
        directory = args.root / Path(tile["metadata_path"]).parent
        prepare_mapped(directory / "terrain.npz", directory / "mapped")
        print(tile["id"], flush=True)


if __name__ == "__main__":
    main()
