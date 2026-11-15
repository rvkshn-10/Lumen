"""Check real southern LOLA elevation samples without downloading 8.5 GB.

This is a source feasibility probe, not a prepared scientific dataset. Partial
HTTP responses must match the requested byte range exactly. Full responses are
rejected before reading their bodies.
"""

import argparse
import hashlib
import json
import math
import ssl
import struct
from pathlib import Path
from urllib.request import Request, urlopen

BASE = (
    "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/"
    "lrolol_1xxx/data/lola_gdr/cylindrical/float_img/"
)
ROWS, COLS, PPD = 23040, 46080, 256
TOTAL_BYTES = ROWS * COLS * 4


def pixel(latitude, longitude):
    if not -90 <= latitude <= 0 or not math.isfinite(longitude):
        raise ValueError("Choose finite coordinates within 0-90 degrees south")
    longitude %= 360
    west = 0 if longitude < 180 else 180
    row = min(ROWS - 1, int(-latitude * PPD))
    col = min(COLS - 1, int((longitude - west) * PPD))
    return west, row, col


def fetch_sample(latitude, longitude, *, context=None, opener=urlopen):
    west, row, col = pixel(latitude, longitude)
    name = f"ldem_256_90s_00s_{west:03d}_{west + 180:03d}_float"
    offset = (row * COLS + col) * 4
    request = Request(
        BASE + name + ".img",
        headers={
            "Range": f"bytes={offset}-{offset + 3}",
            "Accept-Encoding": "identity",
        },
    )
    with opener(request, timeout=45, context=context) as response:
        expected = f"bytes {offset}-{offset + 3}/{TOTAL_BYTES}"
        if response.status != 206 or response.headers.get("Content-Range") != expected:
            raise ValueError("Server did not return the exact requested byte range")
        raw = response.read(5)
        if len(raw) != 4:
            raise ValueError("Incomplete or oversized elevation sample")
    elevation = struct.unpack("<f", raw)[0] * 1000
    if not math.isfinite(elevation) or not -15000 <= elevation <= 15000:
        raise ValueError(
            "Invalid lunar elevation; check units or missing-data encoding"
        )
    return {
        "requested_latitude_deg": latitude,
        "requested_longitude_deg_east": longitude,
        "pixel_latitude_deg": -(row + 0.5) / PPD,
        "pixel_longitude_deg_east": (west + (col + 0.5) / PPD + 180) % 360 - 180,
        "row": row,
        "column": col,
        "elevation_m": elevation,
        "url": BASE + name + ".img",
        "label_url": BASE + name + ".lbl",
        "sample_sha256": hashlib.sha256(raw).hexdigest(),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", type=Path, default=Path("data/cache/lola-feasibility.json")
    )
    parser.add_argument(
        "--system-trust",
        action="store_true",
        help="Use installed truststore with the Windows certificate store",
    )
    args = parser.parse_args()
    if args.system_trust:
        import truststore

        context = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    else:
        context = ssl.create_default_context()
    samples, errors = [], []
    for lat, lon in [(-3.0128, -23.4219), (-35, 0), (-60, 90), (-80, -90)]:
        try:
            samples.append(fetch_sample(lat, lon, context=context))
        except (OSError, ValueError) as exc:
            errors.append(
                {"latitude_deg": lat, "longitude_deg_east": lon, "error": str(exc)}
            )
    report = {
        "source": "NASA PDS LOLA LDEM V3.0",
        "pixels_per_degree": PPD,
        "north_south_spacing_m": 1737400 * math.pi / 180 / PPD,
        "southern_hemisphere_download_bytes": 2 * TOTAL_BYTES,
        "samples": samples,
        "errors": errors,
        "passed": len(samples) == 4,
        "analysis_ready": False,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
