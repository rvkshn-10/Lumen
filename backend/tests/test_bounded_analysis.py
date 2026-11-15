"""Exercise real process termination, admission control and disconnect cleanup."""

import asyncio
import subprocess
import sys
from time import perf_counter

import pytest
from fastapi import HTTPException

from app.services import bounded_analysis as service


@pytest.fixture(params=[False, True], autouse=True)
def worker_mode(request, monkeypatch):
    service.worker_pool.discard()
    monkeypatch.setenv("LUMEN_REUSE_WORKER", "1" if request.param else "0")
    monkeypatch.setattr(service.worker_pool, "source_revision", lambda environment: "test")
    yield request.param
    service.worker_pool.discard()


class Connected:
    async def is_disconnected(self):
        return False


def install_worker(monkeypatch, code):
    original = subprocess.Popen
    processes = []

    def spawn(*args, **kwargs):
        process = original([sys.executable, "-c", code], **kwargs)
        processes.append(process)
        return process

    monkeypatch.setattr(service.subprocess, "Popen", spawn)
    return processes


def test_deadline_kills_worker_and_releases_capacity(monkeypatch):
    processes = install_worker(monkeypatch, "import time; time.sleep(60)")
    monkeypatch.setattr(service, "ANALYSIS_SECONDS", 0.2)
    start = perf_counter()
    with pytest.raises(HTTPException) as failure:
        asyncio.run(service.bounded_analysis("search", {}, Connected()))
    assert failure.value.status_code == 504
    assert failure.value.detail["code"] == "timeout"
    assert perf_counter() - start < 2
    assert processes[0].poll() is not None
    assert not service._active


def test_no_queue_and_cancel_kills_worker(monkeypatch):
    processes = install_worker(monkeypatch, "import time; time.sleep(60)")

    async def exercise():
        task = asyncio.create_task(service.bounded_analysis("search", {}, Connected()))
        await asyncio.sleep(0.1)
        with pytest.raises(HTTPException) as failure:
            await service.bounded_analysis("preview", {}, Connected())
        assert failure.value.status_code == 429
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(exercise())
    assert processes[0].poll() is not None
    assert not service._active


def test_disconnect_kills_worker(monkeypatch):
    processes = install_worker(monkeypatch, "import time; time.sleep(60)")

    class Disconnected:
        async def is_disconnected(self):
            return True

    with pytest.raises(HTTPException) as failure:
        asyncio.run(service.bounded_analysis("search", {}, Disconnected()))
    assert failure.value.status_code == 499
    assert processes[0].poll() is not None
    assert not service._active


def test_worker_result_is_decoded(monkeypatch):
    install_worker(monkeypatch, 'import json; print(json.dumps({"result":{"ok": True}}))')
    assert asyncio.run(service.bounded_analysis("search", {}, Connected())) == {"ok": True}


def test_reusable_worker_retains_process_and_restarts_on_revision(monkeypatch, worker_mode):
    if not worker_mode:
        pytest.skip("Reusable protocol only")
    processes = install_worker(
        monkeypatch,
        """
import json, sys
count = 0
for line in sys.stdin:
    payload = json.loads(line)
    count += 1
    print(json.dumps({"result": {"count": count, "payload": payload["payload"]}}), flush=True)
""",
    )
    first = asyncio.run(service.bounded_analysis("search", {"a": 1}, Connected()))
    second = asyncio.run(service.bounded_analysis("search", {"a": 2}, Connected()))
    assert first == {"count": 1, "payload": {"a": 1}}
    assert second == {"count": 2, "payload": {"a": 2}}
    assert len(processes) == 1 and processes[0].poll() is None
    monkeypatch.setattr(service.worker_pool, "source_revision", lambda environment: "changed")
    third = asyncio.run(service.bounded_analysis("search", {}, Connected()))
    assert third["count"] == 1
    assert len(processes) == 2 and processes[0].poll() is not None


def test_hemisphere_search_reuses_worker_by_default(monkeypatch, worker_mode):
    if not worker_mode:
        pytest.skip("Automatic reuse case")
    monkeypatch.delenv("LUMEN_REUSE_WORKER")
    processes = install_worker(monkeypatch, '''
import json, sys
for line in sys.stdin:
    print(json.dumps({"result": {"ok": True}}), flush=True)
''')
    payload = {"region": {"center": {"latitude_deg": -35}}}
    for _ in range(2):
        assert asyncio.run(service.bounded_analysis("search", payload, Connected())) == {"ok": True}
    assert len(processes) == 1 and processes[0].poll() is None


def test_http_safety_watchdog_is_separate_from_latency_target(monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import app

    assert service.ANALYSIS_SECONDS == 120
    processes = install_worker(monkeypatch, "import time; time.sleep(60)")
    monkeypatch.setattr(service, "ANALYSIS_SECONDS", 0.2)
    start = perf_counter()
    response = TestClient(app).post(
        "/api/v1/candidates/search",
        json={
            "region": {
                "selector_type": "circle",
                "center": {"latitude_deg": -89.9, "longitude_deg_east": 0},
                "search_radius_km": 3,
            },
            "time_range": {"start_utc": "2028-10-01T00:00:00Z", "end_utc": "2028-10-02T00:00:00Z"},
        },
    )
    elapsed = perf_counter() - start
    assert response.status_code == 504
    assert response.json()["detail"]["code"] == "timeout"
    assert elapsed < 2
    assert processes[0].poll() is not None
    assert not service._active
