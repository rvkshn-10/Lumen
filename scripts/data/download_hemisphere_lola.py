"""Resumable bounded parallel range downloads of the official southern LOLA tiles."""

import concurrent.futures
import os
import shutil
import subprocess
from pathlib import Path

from probe_hemisphere_lola import BASE, TOTAL_BYTES

ROOT = Path(__file__).resolve().parents[2] / "data/raw/hemisphere-lola"
CHUNK = 32 * 1024 * 1024


def download(job):
    west, start, end = job
    name = f"ldem_256_90s_00s_{west:03d}_{west + 180:03d}_float.img"
    directory = ROOT / (name + ".parts")
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{start:012d}.bin"
    if path.exists() and path.stat().st_size == end - start + 1:
        return
    partial = path.with_suffix(".partial")
    headers = path.with_suffix(".headers")
    subprocess.run(
        [
            shutil.which("curl.exe") or "curl",
            "--silent",
            "--show-error",
            "--fail",
            "--retry",
            "3",
            "--max-time",
            "240",
            "--range",
            f"{start}-{end}",
            "-D",
            str(headers),
            "-o",
            str(partial),
            BASE + name,
        ],
        check=True,
        creationflags=0x08000000 if os.name == "nt" else 0,
    )
    expected = f"content-range: bytes {start}-{end}/{TOTAL_BYTES}"
    if (
        expected not in headers.read_text().lower()
        or partial.stat().st_size != end - start + 1
    ):
        raise ValueError(f"Invalid partial response: {path}")
    partial.replace(path)


def main():
    jobs = [
        (west, start, min(start + CHUNK, TOTAL_BYTES) - 1)
        for west in (0, 180)
        for start in range(0, TOTAL_BYTES, CHUNK)
    ]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        for i, _ in enumerate(executor.map(download, jobs), 1):
            if i % 8 == 0:
                print(f"Verified download chunks {i}/{len(jobs)}", flush=True)
    for west in (0, 180):
        name = f"ldem_256_90s_00s_{west:03d}_{west + 180:03d}_float.img"
        target = ROOT / (name + ".partial")
        with target.open("wb") as out:
            for start in range(0, TOTAL_BYTES, CHUNK):
                path = ROOT / (name + ".parts") / f"{start:012d}.bin"
                with path.open("rb") as stream:
                    while block := stream.read(1024 * 1024):
                        out.write(block)
        print(f"Assembled {name}", flush=True)
    # Rays from equatorial candidates can cross north of the equator by 6.6 deg.
    for west in (0, 180):
        target = ROOT / f"north-buffer-{west:03d}.img.partial"
        installed = ROOT / f"north-buffer-{west:03d}.img"
        if installed.exists() and installed.stat().st_size == 353894400:
            continue
        if target.exists() and target.stat().st_size == 353894400:
            continue
        name = f"ldem_256_00n_90n_{west:03d}_{west + 180:03d}_float.img"
        headers = target.with_suffix(".headers")
        subprocess.run(
            [
                shutil.which("curl.exe") or "curl",
                "--fail",
                "--silent",
                "--show-error",
                "--retry",
                "3",
                "--max-time",
                "900",
                "--range",
                "3892838400-4246732799",
                "-D",
                str(headers),
                "-o",
                str(target),
                BASE + name,
            ],
            check=True,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        if (
            target.stat().st_size != 353894400
            or "content-range: bytes 3892838400-4246732799/4246732800"
            not in headers.read_text().lower()
        ):
            raise ValueError("Invalid northern horizon buffer download")


if __name__ == "__main__":
    main()
