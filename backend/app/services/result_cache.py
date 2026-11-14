"""Small checksum-verified disk cache shared by the isolated analysis workers."""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import tempfile
import zlib
from pathlib import Path

from app.settings import REPOSITORY_ROOT

ROOT = REPOSITORY_ROOT / "data/cache/v2-results"
MAX_BYTES = 64 * 1024 * 1024


def cached_result(operation: str, request: str, sources: str, calculate, *, root: Path = ROOT):
    key = hashlib.sha256(json.dumps(["v2-result-1", operation, request, sources]).encode()).hexdigest()
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
