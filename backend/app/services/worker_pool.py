"""One reusable, killable worker. Source revisions invalidate its scientific caches."""

import atexit
import json
import os
import subprocess
import sys
from contextlib import suppress
from pathlib import Path

import orjson

_process = None
_revision = None


def source_revision(environment):
    root = Path(environment["LUMEN_DATA_ROOT"])
    kernels = Path(environment["LUMEN_KERNEL_ROOT"])
    paths = {
        root / "metadata.json",
        root / "catalog.json",
        root / "features.json",
        root / "psr.json",
        kernels / "manifest.json",
    }
    if (root / "metadata.json").exists():
        metadata = json.loads((root / "metadata.json").read_text())
        paths.update(root / name for name in metadata.get("artifacts", {}))
    if (root / "catalog.json").exists():
        catalog = json.loads((root / "catalog.json").read_text())
        for tile in catalog["tiles"]:
            metadata = root / tile["metadata_path"]
            paths.add(metadata)
            paths.update(metadata.parent / name for name in tile["artifacts"])
            if environment.get("LUMEN_MMAP_TILES", "0") == "1":
                mapped = metadata.parent / "mapped"
                paths.add(mapped / "manifest.json")
                paths.update(mapped.glob("*.npy"))
    hemisphere = Path(environment.get("LUMEN_HEMISPHERE_ROOT", str(Path(__file__).resolve().parents[3]/"data/raw/hemisphere-lola")))
    paths.add(hemisphere/"manifest.json")
    if (hemisphere/"manifest.json").exists():
        for item in json.loads((hemisphere/"manifest.json").read_text())["files"].values():
            paths.add(hemisphere/item["file"])
    if (kernels / "manifest.json").exists():
        paths.update(
            kernels / item["file"] for item in json.loads((kernels / "manifest.json").read_text())
        )
    stamps = []
    for path in sorted(paths):
        try:
            stat = path.stat()
            stamps.append((str(path), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns))
        except FileNotFoundError:
            stamps.append((str(path), None))
    return (
        tuple(stamps),
        environment.get("LUMEN_TEMPORAL_KERNEL", "reference"),
        environment.get("LUMEN_TILE_CACHE_BYTES"),
        environment.get("LUMEN_MMAP_TILES", "0"),
    )


def discard(process=None):
    global _process, _revision
    target = process if process is not None else _process
    if target is _process:
        _process = None
        _revision = None
    if target is not None:
        if target.poll() is None:
            target.kill()
        target.wait()
        for stream in (target.stdin, target.stdout, target.stderr):
            if stream is not None:
                with suppress(OSError):
                    stream.close()


def acquire(environment):
    global _process, _revision
    revision = source_revision(environment)
    if _process is not None and (_process.poll() is not None or revision != _revision):
        discard()
    if _process is None:
        _process = subprocess.Popen(
            [sys.executable, "-m", "app.analysis_worker", "serve"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=environment,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        _revision = revision
    return _process


def exchange(process, operation, payload):
    process.stdin.write(orjson.dumps({"operation": operation, "payload": payload}) + b"\n")
    process.stdin.flush()
    output = process.stdout.readline()
    if not output:
        raise OSError("Analysis worker closed its output")
    return output


atexit.register(discard)
