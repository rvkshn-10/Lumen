"""Verify staged NASA LOLA files and publish a local source manifest last."""

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from app.services.hemisphere_terrain import COLS, ROOT, VERSION
from app.services.terrain_store import digest


def main():
    catalog = json.loads((Path(__file__).parent/"source_catalog.json").read_text())
    pinned = next(item for item in catalog["sources"] if item["id"]=="hemisphere-lola-256ppd").get("pinned_files",{})
    files = {}
    for west in (0, 180):
        for north in (False, True):
            name = (
                f"north-buffer-{west:03d}.img"
                if north
                else f"ldem_256_90s_00s_{west:03d}_{west + 180:03d}_float.img"
            )
            path = ROOT / name
            staged = path.with_suffix(".img.partial")
            if not path.exists():
                if staged.stat().st_size != (1920 if north else 23040) * COLS * 4:
                    raise ValueError(f"Incomplete source file: {staged}")
                staged.replace(path)
            if path.stat().st_size != (1920 if north else 23040) * COLS * 4:
                raise ValueError(f"Invalid source shape: {path}")
            # Validate all heights in bounded row groups, then pin the downloaded bytes.
            values = np.memmap(path, dtype="<f4", mode="r")
            for offset in range(0, len(values), 1024 * 1024):
                chunk = values[offset : offset + 1024 * 1024]
                if not np.isfinite(chunk).all() or (np.abs(chunk) > 15).any():
                    raise ValueError(f"Unknown elevation encoding: {path}")
            del values
            key=f"{'north' if north else 'south'}-{west:03d}"
            checksum=digest(path)
            if key in pinned and checksum != pinned[key]["sha256"]:
                raise ValueError(f"Pinned source checksum mismatch: {path}")
            files[f"{'north' if north else 'south'}-{west:03d}"] = {
                "file": name,
                "bytes": path.stat().st_size,
                "sha256": checksum,
            }
            print(f"Verified {name}", flush=True)
    manifest = {
        "version": VERSION,
        "reference_radius_m": 1737400,
        "pixels_per_degree": 256,
        "units": "kilometres, converted to metres",
        "source_frame": "MEAN EARTH/POLAR AXIS OF DE421",
        "source_url": "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/float_img/",
        "files": files,
    }
    temporary = ROOT / "manifest.partial.json"
    temporary.write_text(json.dumps(manifest, indent=2) + "\n")
    temporary.replace(ROOT / "manifest.json")


if __name__ == "__main__":
    main()
