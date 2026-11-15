"""One reusable, killable worker. Source revisions invalidate its scientific caches."""

import atexit
import hashlib
import json
import os
import subprocess
import sys
from contextlib import suppress
from pathlib import Path
from threading import Lock

import orjson
import psutil

_process = None
_revision = None
_write_lock = Lock()


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
    # Track every scientific code revision, prepared survey and global horizon source.
    code_root = Path(__file__).resolve().parents[1]
    code = hashlib.sha256()
    for path in sorted(code_root.rglob("*.py")):
        code.update(str(path.relative_to(code_root)).encode())
        code.update(path.read_bytes())
    global_root = Path(environment.get("LUMEN_GLOBAL_ROOT", str(code_root.parents[1] / "data/derived/global-preview-v1")))
    paths.update([hemisphere / "survey/manifest.json", hemisphere / "survey/terrain.npz",
                  global_root / "metadata.json", global_root / "elevation.npz"])
    from app.services.result_cache import software_revision
    from app.services.terrain_store import artifact_stamp

    stamps = []
    for path in sorted(paths):
        try:
            stamps.append((str(path), *artifact_stamp(path),
                           hashlib.sha256(path.read_bytes()).hexdigest() if path.suffix == ".json" else None))
        except FileNotFoundError:
            stamps.append((str(path), None))
    return (
        tuple(stamps),
        code.hexdigest(),
        software_revision(),
        environment.get("LUMEN_TEMPORAL_KERNEL", "reference"),
        environment.get("LUMEN_MAXIMUM_RADIUS_KM", "5"),
        environment.get("LUMEN_TILE_CACHE_BYTES"),
        environment.get("LUMEN_MMAP_TILES", "0"),
    )


def discard(process=None, *, close=True):
    global _process, _revision
    target = process if process is not None else _process
    if target is _process:
        _process = None
        _revision = None
    if target is not None:
        # Windows venv launchers may own a separate Python child with the pipe handles.
        with suppress(psutil.Error):
            for child in psutil.Process(target.pid).children(recursive=True):
                with suppress(psutil.Error):
                    child.kill()
        if target.poll() is None:
            with suppress(OSError):
                target.kill()
        target.wait()
        if close:
            close_streams(target)


def close_streams(process):
    for name in ("stdin", "stdout", "stderr"):
        stream = getattr(process, name, None)
        if stream is not None:
            with suppress(OSError, ValueError):
                stream.close()


def acquire(environment):
    global _process, _revision
    revision = source_revision(environment)
    if _process is not None and (_process.poll() is not None or revision != _revision):
        discard()
    if _process is None:
        environment = dict(environment)
        environment["LUMEN_SCIENCE_REVISION"] = hashlib.sha256(orjson.dumps(revision)).hexdigest()
        # Native libraries otherwise create many CPU threads for speculative preparation.
        for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMBA_NUM_THREADS"):
            environment[name] = "1"
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


def send(process, operation, payload=None):
    with _write_lock:
        process.stdin.write(orjson.dumps({"operation": operation, "payload": payload}) + b"\n")
        process.stdin.flush()


def exchange(process, operation, payload, sent=False):
    if not sent:
        send(process, operation, payload)
    output = process.stdout.readline()
    if not output:
        raise OSError("Analysis worker closed its output")
    return output


atexit.register(discard)
