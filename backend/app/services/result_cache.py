"""Small checksum-verified disk cache shared by the isolated analysis workers."""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import sys
import tempfile
import zlib
from collections import OrderedDict
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

import orjson

from app.settings import REPOSITORY_ROOT

ROOT = Path(os.getenv("LUMEN_RESULT_CACHE_ROOT", REPOSITORY_ROOT / "data/cache/v2-results"))
MAX_BYTES = 64 * 1024 * 1024


def cached_result(operation: str, request: str, sources: str, calculate, *, root: Path = ROOT):
    key = hashlib.sha256(json.dumps(["v2-result-2", os.getenv("LUMEN_SCIENCE_REVISION", "direct"), operation, request, sources, code_revision(), software_revision()]).encode()).hexdigest()
    path = root / f"{key}.json.gz"
    try:
        envelope = json.loads(gzip.decompress(path.read_bytes()))
        serialized = envelope["result"]
        if envelope["key"] == key and hashlib.sha256(serialized.encode()).hexdigest() == envelope["sha256"]:
            return json.loads(serialized)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, EOFError, zlib.error):
        pass  # Optional cache corruption never becomes scientific evidence.
    result = calculate()
    serialized = json.dumps(result, separators=(",", ":"), allow_nan=False)
    packed = gzip.compress(json.dumps({"key": key, "sha256": hashlib.sha256(serialized.encode()).hexdigest(),
                                       "result": serialized}).encode(), mtime=0)
    if len(packed) <= MAX_BYTES:
        try:
            root.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=root, suffix=".partial", delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(packed)
            os.replace(temporary, path)
            files = sorted(root.glob("*.json.gz"), key=lambda item: item.stat().st_mtime, reverse=True)
            used = 0
            for cached in files:
                used += cached.stat().st_size
                if used > MAX_BYTES:
                    cached.unlink(missing_ok=True)
        except OSError:
            pass  # Read-only hosting still returns freshly computed science.
    return result


def software_revision():
    packages = []
    for name in ("numpy", "spiceypy", "numba"):
        try:
            packages.append((name, version(name)))
        except PackageNotFoundError:
            packages.append((name, None))
    return (sys.version_info[:3], tuple(packages))


def code_revision():
    root = Path(__file__).resolve().parents[1]
    value = hashlib.sha256()
    for path in sorted(root.rglob("*.py")):
        value.update(str(path.relative_to(root)).encode())
        value.update(path.read_bytes())
    return value.hexdigest()


def exact_key(operation, payload, revision):
    return hashlib.sha256(orjson.dumps(
        ["exact-search-v1", revision, operation, payload], option=orjson.OPT_SORT_KEYS
    )).hexdigest()


class ResultCache:
    def __init__(self, max_bytes=64 * 1024 * 1024, max_entries=8):
        self.max_bytes, self.max_entries = max_bytes, max_entries
        self.entries = OrderedDict()
        self.bytes = 0

    def get(self, key):
        if key not in self.entries:
            return None
        self.entries.move_to_end(key)
        return orjson.loads(self.entries[key])

    def put(self, key, response):
        data = orjson.dumps(response)
        if len(data) > self.max_bytes or self.max_entries < 1:
            return
        previous = self.entries.pop(key, None)
        self.bytes -= len(previous) if previous else 0
        while self.entries and (self.bytes + len(data) > self.max_bytes or len(self.entries) >= self.max_entries):
            self.bytes -= len(self.entries.popitem(last=False)[1])
        self.entries[key] = data
        self.bytes += len(data)
