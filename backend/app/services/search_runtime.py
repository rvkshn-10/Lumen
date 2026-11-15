"""One speculative preparation, one foreground calculation, no background queue.

Preparation is cooperatively interrupted at hash chunks/horizon batches. Completed
verified files and geometry batches stay in the existing scientific worker caches.
The kill fallback bounds handoff latency; its wait is outside the search watchdog.
"""

import asyncio
import time
import uuid
from contextlib import suppress

import orjson
import psutil
from fastapi import HTTPException

from app.services import worker_pool
from app.services.result_cache import exact_key

instance = None
PREPARATION_SECONDS = 180.0
HANDOFF_SECONDS = 0.35
MEMORY_BYTES = 768 * 1024 * 1024
LEASE_SECONDS = 25.0


def resident_bytes(process):
    parent = psutil.Process(process.pid)
    return sum(item.memory_info().rss for item in [parent, *parent.children(recursive=True)])


class SearchRuntime:
    def __init__(self, environment, enabled=True):
        self.environment = environment
        self.enabled = enabled
        self.revision = None
        self.verified_revision = None
        self.survey_ready = False
        self.job = None
        self.background = None
        self.background_process = None
        self.foreground_task = None
        self.foreground_key = None
        self.subscribers = 0
        self.closed = False
        self.monitor = None
        self.control = asyncio.Lock()
        self.admission = asyncio.Lock()

    async def start(self):
        try:
            self.revision = await asyncio.to_thread(worker_pool.source_revision, self.environment)
        except (OSError, ValueError, KeyError):
            self._new_job(None)
            self.job.update(state="unavailable", message="Scientific preparation unavailable. Submit normally.")
            self.monitor = asyncio.create_task(self._watch())
            return
        if self.enabled:
            self._new_job(None)
            self._start_pending()
        self.monitor = asyncio.create_task(self._watch())

    def _new_job(self, request):
        self.job = {"id": uuid.uuid4().hex, "state": "preparing", "request": request,
                    "expires": time.monotonic() + LEASE_SECONDS if request else None,
                    "message": "Preparing installed terrain and ephemeris data."}

    def _start_pending(self):
        if (self.enabled and not self.closed and not self.foreground_task and not self.background
                and self.job and self.job["state"] == "preparing"):
            self.background = asyncio.create_task(self._prepare(self.job))

    async def _prepare(self, job):
        communication = None
        process = None
        try:
            process = worker_pool.acquire(self.environment)
            worker_pool.send(process, "prepare", {"request": job["request"]})
            self.background_process = process
            communication = asyncio.create_task(asyncio.to_thread(
                worker_pool.exchange, process, "prepare", {"request": job["request"]}, True
            ))
            started = time.monotonic()
            while not communication.done():
                if time.monotonic() - started > PREPARATION_SECONDS:
                    raise TimeoutError("Preparation budget exceeded; submit normally.")
                resident = resident_bytes(process)
                job["peak_resident_bytes"] = max(job.get("peak_resident_bytes", 0), resident)
                if resident > MEMORY_BYTES:
                    raise MemoryError("Preparation memory budget exceeded; submit normally.")
                await asyncio.wait({communication}, timeout=0.1)
            response = orjson.loads(communication.result())
            if response.get("canceled"):
                job["message"] = "Foreground work has priority. You can submit normally."
            elif "error" in response:
                job.update(state="unavailable", message="Preparation unavailable. You can submit normally.")
            else:
                job["seconds"] = response["result"].get("seconds", 0)
                if response["result"].get("verified_sources"):
                    self.verified_revision = worker_pool._revision
                    self.survey_ready = response["result"].get("survey_ready", False)
                job.update(state="ready", message="Installed data prepared. Mission calculations run on submission.")
        except (OSError, ValueError, TimeoutError, MemoryError, psutil.Error):
            job.update(state="unavailable", message="Preparation unavailable. You can submit normally.")
            if process is not None:
                await asyncio.to_thread(worker_pool.discard, process, close=False)
        finally:
            if communication:
                if not communication.done() and process is not None:
                    await asyncio.to_thread(worker_pool.discard, process, close=False)
                await asyncio.gather(communication, return_exceptions=True)
                if process is not None and process.poll() is not None:
                    worker_pool.close_streams(process)
            if self.background is asyncio.current_task():
                self.background = None
                self.background_process = None

    async def stop_background(self):
        task, process = self.background, self.background_process
        if task is None:
            return
        if process is None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            if self.background is task:
                self.background = None
            return
        if process is not None:
            with suppress(OSError, ValueError):
                worker_pool.send(process, "cancel_prepare")
        try:
            await asyncio.wait_for(asyncio.shield(task), HANDOFF_SECONDS)
        except TimeoutError:
            if process is not None:
                await asyncio.to_thread(worker_pool.discard, process, close=False)
            await asyncio.gather(task, return_exceptions=True)

    async def refresh_revision(self):
        async with self.control:
            return await self._refresh_revision()

    async def _refresh_revision(self):
        current = await asyncio.to_thread(worker_pool.source_revision, self.environment)
        if current != self.revision and not self.foreground_task:
            await self.stop_background()
            await asyncio.to_thread(worker_pool.discard)
            self.revision = current
            self.verified_revision = None
            self._new_job(None)
            self._start_pending()
        return current

    async def prepare(self, request):
        async with self.control:
            await self._refresh_revision()
            if not self.enabled:
                return {"state": "unavailable", "message": "Background preparation is disabled."}
            if self.job and self.job["request"] == request and self.job["state"] != "unavailable":
                if request:
                    self.job["expires"] = time.monotonic() + LEASE_SECONDS
                return self.status()
            await self.stop_background()
            self._new_job(request)
            self._start_pending()
            return self.status()

    def status(self, identifier=None):
        if not self.enabled or self.job is None or (identifier and identifier != self.job["id"]):
            return {"state": "unavailable", "message": "Preparation expired. You can submit normally."}
        if self.job["expires"]:
            self.job["expires"] = time.monotonic() + LEASE_SECONDS
        return {key: self.job[key] for key in ("id", "state", "message")}

    async def cancel(self, identifier):
        async with self.control:
            if self.job and self.job["id"] == identifier:
                await self.stop_background()
                self.job.update(state="unavailable", message="Preparation canceled. You can submit normally.")

    async def _watch(self):
        while not self.closed:
            await asyncio.sleep(1)
            if self.job and self.job["expires"] and time.monotonic() > self.job["expires"]:
                await self.cancel(self.job["id"])
            try:
                if not self.foreground_task and worker_pool._process is not None and worker_pool._process.poll() is not None:
                    await asyncio.to_thread(worker_pool.discard)
                    if self.job:
                        self.job.update(state="unavailable", message="Preparation worker stopped. Submit normally.")
                await self.refresh_revision()
            except (OSError, ValueError, KeyError):
                if self.job:
                    self.job.update(state="unavailable", message="Scientific sources changed or are unavailable.")

    async def foreground(self, operation, payload, request, calculate):
        revision = await self.refresh_revision()
        key = exact_key(operation, payload, revision)
        async with self.admission:
            # No awaits between admission and publishing the shared task.
            if self.foreground_task is not None and self.foreground_key != key:
                raise HTTPException(429, {"code": "queue_full", "message": "Another analysis is running. Your inputs are saved; retry shortly."})
            if self.foreground_task is None:
                self.foreground_key = key

                async def execute():
                    context = _Connected()
                    started = time.perf_counter()
                    await self.stop_background()  # Never charged to the calculation watchdog.
                    handoff = time.perf_counter() - started
                    response = await calculate(operation, payload, context)
                    timings = getattr(context.state, "search_timings", {})
                    timings["preparation_handoff"] = handoff
                    context.state.search_timings = timings
                    if await asyncio.to_thread(worker_pool.source_revision, self.environment) != revision:
                        await asyncio.to_thread(worker_pool.discard)
                        raise HTTPException(503, "Scientific sources changed during analysis. Resubmit your retained mission.")
                    return response, vars(context.state)

                self.foreground_task = asyncio.create_task(execute())
            task = self.foreground_task
            self.subscribers += 1
        try:
            while not task.done():
                if await request.is_disconnected():
                    raise HTTPException(499, "Analysis canceled.")
                await asyncio.wait({task}, timeout=0.05)
            result, state = task.result()
            if hasattr(request, "state"):
                for name, value in state.items():
                    setattr(request.state, name, value)
            return result
        finally:
            async with self.admission:
                self.subscribers -= 1
                if self.subscribers == 0:
                    if not task.done():
                        task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                    self.foreground_task = None
                    self.foreground_key = None
                    self._start_pending()

    async def close(self):
        self.closed = True
        if self.monitor:
            self.monitor.cancel()
            await asyncio.gather(self.monitor, return_exceptions=True)
        if self.foreground_task:
            self.foreground_task.cancel()
            await asyncio.gather(self.foreground_task, return_exceptions=True)
        await self.stop_background()
        await asyncio.to_thread(worker_pool.discard)


class _Connected:
    class State:
        pass

    def __init__(self):
        self.state = self.State()

    async def is_disconnected(self):
        return False
