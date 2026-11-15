"""Publish the locally verified survey with pinned provenance for small hosts."""

import json
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "backend"))


def main():
    from app.global_api import global_grid
    from app.services.hemisphere_survey import ROOT, grid_digest, load
    from app.services.terrain_store import digest

    metadata, arrays = load()  # Verify raw source, global grid, archive and lattice first.
    directory = REPO / "data/derived/hemisphere-survey-v2"
    directory.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((ROOT / "survey/manifest.json").read_text())
    manifest["detailed_source"] = metadata["source"]
    manifest["global_source"] = metadata["global_horizon_source"]
    manifest["global_grid_sha256"] = grid_digest(global_grid()[1])
    shutil.copyfile(ROOT / "survey/terrain.npz", directory / "terrain.npz")
    path = directory / "manifest.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")
    (REPO / "backend/app/data/hemisphere-survey-release.json").write_text(
        json.dumps({"manifest_sha256": digest(path)}, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    print(f"Published verified {len(arrays['ids'])}-site survey ({manifest['bytes']} bytes).")


if __name__ == "__main__":
    main()
