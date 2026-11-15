import asyncio
import copy
import threading
from types import SimpleNamespace

import numpy as np
import orjson
import pytest
from fastapi import HTTPException

from app.services import hemisphere_terrain as terrain
from app.services import preparation_control, search_runtime, worker_pool
from app.services.result_cache import ResultCache, exact_key


class Connected:
    async def is_disconnected(self):
        return False


@pytest.fixture
def runtime(monkeypatch):
    started, release, canceled = threading.Event(), threading.Event(), threading.Event()
    process = SimpleNamespace(poll=lambda: None)
    calls = []
    revision = ["source-v1"]
    monkeypatch.setattr(worker_pool, "source_revision", lambda env: revision[0])
    monkeypatch.setattr(worker_pool, "acquire", lambda env: process)
    monkeypatch.setattr(worker_pool, "discard", lambda *args: calls.append("discard"))
    def send(process, operation, payload=None):
        if operation == "cancel_prepare":
            canceled.set()
        else:
            canceled.clear()
    monkeypatch.setattr(worker_pool, "send", send)
    monkeypatch.setattr(search_runtime, "resident_bytes", lambda process: 1024)

    def exchange(process, operation, payload, sent=False):
        calls.append(payload)
        if not sent:
            canceled.clear()
        started.set()
        for _ in range(2000):
            if release.wait(0.005):
                break
            if canceled.is_set():
                return orjson.dumps({"canceled": True})
        return orjson.dumps({"result": {"state": "ready"}})

    monkeypatch.setattr(worker_pool, "exchange", exchange)
    return SimpleNamespace(manager=search_runtime.SearchRuntime({}), started=started,
                           release=release, canceled=canceled, calls=calls, revision=revision)


async def until(predicate):
    async with asyncio.timeout(5):
        while not predicate():
            await asyncio.sleep(0.005)


def test_foreground_preempts_and_matching_callers_share_calculation(runtime):
    async def exercise():
        manager = runtime.manager
        await manager.start()
        await until(runtime.started.is_set)
        entered = asyncio.Event()
        finish = asyncio.Event()
        count = 0

        async def calculate(*args):
            nonlocal count
            count += 1
            assert runtime.canceled.is_set()
            assert manager.background is None
            entered.set()
            await finish.wait()
            return {"science": [1, 2, 3]}

        try:
            one = asyncio.create_task(manager.foreground("search", {"area": 1}, Connected(), calculate))
            await entered.wait()
            two = asyncio.create_task(manager.foreground("search", {"area": 1}, Connected(), calculate))
            await until(lambda: manager.subscribers == 2)
            with pytest.raises(HTTPException) as failure:
                await manager.foreground("search", {"area": 2}, Connected(), calculate)
            assert failure.value.status_code == 429
            one.cancel()
            with pytest.raises(asyncio.CancelledError):
                await one
            assert not two.done()  # One disconnected subscriber cannot cancel another's calculation.
            finish.set()
            assert await two == {"science": [1, 2, 3]}
            assert count == 1
        finally:
            await manager.close()
    asyncio.run(exercise())


def test_latest_area_only_deduplicates_and_cancels_old_lease(runtime):
    async def exercise():
        manager = runtime.manager
        await manager.start()
        await until(runtime.started.is_set)
        first = await manager.prepare({"area": 1})
        repeated = await manager.prepare({"area": 1})
        assert first["id"] == repeated["id"]
        second = await manager.prepare({"area": 2})
        assert first["id"] != second["id"]
        await manager.cancel(first["id"])
        assert manager.status(second["id"])["state"] == "preparing"
        runtime.release.set()
        await until(lambda: manager.status()["state"] == "ready")
        assert manager.job["request"] == {"area": 2}
        assert len(runtime.calls) <= 3  # Startup plus two areas, no queue of past requests.
        manager.job["expires"] = 0.001
        await until(lambda: manager.job["state"] == "unavailable")
        await manager.close()
    asyncio.run(exercise())


def test_revision_change_invalidates_ready_worker_and_inflight_result(runtime):
    async def exercise():
        manager = runtime.manager
        runtime.release.set()
        await manager.start()
        await until(lambda: manager.status()["state"] == "ready")
        old = manager.status()["id"]
        runtime.revision[0] = "source-v2"
        await manager.refresh_revision()
        assert manager.status()["id"] != old
        assert "discard" in runtime.calls

        async def calculate(*args):
            runtime.revision[0] = "source-v3"
            return {"obsolete": True}

        with pytest.raises(HTTPException) as failure:
            await manager.foreground("search", {}, Connected(), calculate)
        assert failure.value.status_code == 503
        await manager.close()
    asyncio.run(exercise())


@pytest.mark.parametrize("failure", ["memory", "deadline", "crash"])
def test_background_resource_failures_leave_foreground_available(runtime, monkeypatch, failure):
    if failure == "memory":
        monkeypatch.setattr(search_runtime, "MEMORY_BYTES", 1)
    elif failure == "deadline":
        monkeypatch.setattr(search_runtime, "PREPARATION_SECONDS", -1)
    else:
        monkeypatch.setattr(worker_pool, "exchange", lambda *args: b"")
    # Fake discard must unblock the fake exchange just as killing a real process closes its pipe.
    monkeypatch.setattr(worker_pool, "discard", lambda *args: runtime.release.set())

    async def exercise():
        manager = runtime.manager
        await manager.start()
        await until(lambda: manager.status()["state"] == "unavailable")
        async def calculate(*args):
            return {"ok": True}
        assert await manager.foreground("search", {}, Connected(), calculate) == {"ok": True}
        await manager.close()
    asyncio.run(exercise())


def test_exact_cache_is_bounded_and_never_aliases_scientific_inputs():
    payload = {"region": {"latitude": -35}, "time": ["2028-10-01", "2028-10-02"],
               "constraints": {"slope": 10}, "weights": [1, 2]}
    key = exact_key("search", payload, "sources-kernels-code-v1")
    for field, value in [("region", {"latitude": -36}), ("time", ["2028-10-02", "2028-10-03"]),
                         ("constraints", {"slope": 11}), ("weights", [2, 1])]:
        changed = copy.deepcopy(payload)
        changed[field] = value
        assert exact_key("search", changed, "sources-kernels-code-v1") != key
    assert exact_key("search", payload, "sources-kernels-code-v2") != key
    cache = ResultCache(max_bytes=60, max_entries=2)
    for i in range(20):
        cache.put(str(i), {"science": [i]})
        assert cache.bytes <= 60 and len(cache.entries) <= 2
    cache.put("huge", {"value": "x" * 1000})
    assert cache.get("huge") is None and cache.get("0") is None
    result = cache.get("19")
    result["science"][0] = -1
    assert cache.get("19") == {"science": [19]}  # Callers cannot mutate cached evidence.


def test_interrupted_geometry_resumes_completed_batches_with_identical_output(monkeypatch):
    lat, lon = np.linspace(-35, -34.99, 13), np.linspace(70, 70.01, 13)
    batches = []
    interrupt = [False]

    def sample(grids, latitude, longitude):
        if np.asarray(latitude).ndim == 3:
            batches.append(len(latitude))
            if interrupt[0]:
                preparation_control.cancel.set()
        return np.sin(np.deg2rad(latitude)) * 500 + np.cos(np.deg2rad(longitude)) * 200

    monkeypatch.setattr(terrain, "sample", sample)
    monkeypatch.setattr(terrain, "_partial", None)
    baseline = terrain.derive({}, lat, lon)
    batches.clear()
    interrupt[0] = True
    preparation_control.cancel.clear()
    with pytest.raises(preparation_control.PreparationCanceled), preparation_control.speculative():
        terrain.derive({}, lat, lon)
    interrupt[0] = False
    preparation_control.cancel.clear()
    resumed = terrain.derive({}, lat, lon)
    assert batches == [8, 5]  # No completed horizon batch was recalculated at handoff.
    for expected, actual in zip(baseline, resumed, strict=True):
        np.testing.assert_array_equal(expected, actual)
    assert terrain._partial is None


def test_worker_exact_cache_and_persistent_cache_return_identical_results(tmp_path, monkeypatch):
    from app import analysis_worker, api
    from app.services.result_cache import cached_result
    monkeypatch.setenv("LUMEN_SCIENCE_REVISION", "version-one")
    monkeypatch.setattr(analysis_worker, "_results", ResultCache())
    monkeypatch.setattr(analysis_worker, "cached_result", lambda op, req, src, calc: cached_result(op, req, src, calc, root=tmp_path))
    calls = []
    def calculate(request):
        calls.append(1)
        return {"science": request.model_dump(mode="json"), "count": len(calls)}
    monkeypatch.setattr(api, "candidate_search_calculation", calculate)
    request = {"region": {"selector_type": "southern_hemisphere"}, "time_range": {
        "start_utc": "2028-10-01T00:00:00Z", "end_utc": "2028-10-02T00:00:00Z"}}
    first = analysis_worker.calculate("search", request)["result"]
    assert analysis_worker.calculate("search", request)["result"] == first
    monkeypatch.setattr(analysis_worker, "_results", ResultCache())
    assert analysis_worker.calculate("search", request)["result"] == first
    assert len(calls) == 1
    changed = copy.deepcopy(request)
    changed["time_range"]["end_utc"] = "2028-10-03T00:00:00Z"
    assert analysis_worker.calculate("search", changed)["result"] != first
    monkeypatch.setenv("LUMEN_SCIENCE_REVISION", "new-kernel-source-code-epoch")
    assert analysis_worker.calculate("search", request)["result"]["count"] == 3


def test_last_foreground_disconnect_cancels_work_and_shutdown_clears_tasks(runtime):
    async def exercise():
        manager = runtime.manager
        await manager.start()
        await until(runtime.started.is_set)
        entered = asyncio.Event()
        canceled = asyncio.Event()
        disconnected = False
        class Request:
            async def is_disconnected(self):
                return disconnected
        async def calculate(*args):
            entered.set()
            try:
                await asyncio.sleep(60)
            finally:
                canceled.set()
        task = asyncio.create_task(manager.foreground("search", {}, Request(), calculate))
        await entered.wait()
        disconnected = True
        with pytest.raises(HTTPException) as failure:
            await task
        assert failure.value.status_code == 499 and canceled.is_set()
        await manager.close()
        assert manager.background is None and manager.monitor.done()
    asyncio.run(exercise())
