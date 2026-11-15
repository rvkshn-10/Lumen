"""Run scientific calculations in a killable process with one shared deadline."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import orjson
from fastapi import HTTPException, Request

from app.services import worker_pool
from app.settings import settings

ANALYSIS_SECONDS = 120.0  # Safety watchdog; the performance target is successful averages under 30s.
_active = False


def worker_environment():
    environment = os.environ.copy()
    environment["LUMEN_DATA_ROOT"] = str(settings.data_root)
    environment["LUMEN_KERNEL_ROOT"] = str(settings.kernel_root)
    environment["PYTHONPATH"] = str(Path(__file__).resolve().parents[2]) + os.pathsep + environment.get("PYTHONPATH", "")
    return environment


async def bounded_analysis(operation: str, payload: dict, request: Request) -> dict:
    from app.services.search_runtime import instance
    if instance is not None:
        try:
            return await instance.foreground(operation, payload, request, _bounded_analysis)
        except (OSError, ValueError, KeyError) as exc:
            raise HTTPException(503, "Scientific preparation unavailable. Your mission is retained.") from exc
    return await _bounded_analysis(operation, payload, request)


async def _bounded_analysis(operation: str, payload: dict, request: Request) -> dict:
    global _active
    # Fail fast instead of allowing queue time to consume the caller's deadline.
    if _active:
        raise HTTPException(
            429,
            detail={
                "code": "queue_full",
                "message": "Another analysis is running. Your inputs are saved; retry shortly.",
            },
        )
    _active = True
    process = None
    communication = None
    reuse = operation == "search" and os.getenv("LUMEN_REUSE_WORKER", "1") == "1"
    successful = False
    try:
        async with asyncio.timeout(ANALYSIS_SECONDS):
            environment = worker_environment()
            if reuse:
                process = worker_pool.acquire(environment)
                communication = asyncio.create_task(
                    asyncio.to_thread(worker_pool.exchange, process, operation, payload)
                )
            else:
                # Uvicorn uses SelectorEventLoop on Windows, which lacks asyncio subprocesses.
                process = subprocess.Popen(  # noqa: ASYNC220
                    [sys.executable, "-m", "app.analysis_worker", operation],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=environment,
                    creationflags=0x08000000 if os.name == "nt" else 0,
                )
                communication = asyncio.create_task(
                    asyncio.to_thread(process.communicate, json.dumps(payload).encode())
                )
            while not communication.done():
                if await request.is_disconnected():
                    raise HTTPException(499, "Analysis canceled.")
                await asyncio.wait({communication}, timeout=0.05)
            output = communication.result() if reuse else communication.result()[0]
            if process.returncode:
                raise HTTPException(503, "The analysis worker stopped. Your inputs are retained.")
            result = orjson.loads(output)
            if "error" in result:
                raise HTTPException(result["status"], result["error"])
            if "timings" in result:
                request.state.search_timings = result["timings"]
            successful = True
            return result["result"]
    except TimeoutError as exc:
        raise HTTPException(
            504,
            detail={
                "code": "timeout",
                "message": "Analysis reached its time limit and was stopped. Try a smaller area or shorter mission window.",
            },
        ) from exc
    except (OSError, ValueError, KeyError) as exc:
        raise HTTPException(503, "Analysis service unavailable. Your inputs are retained.") from exc
    finally:
        try:
            if reuse and not successful or not reuse and process is not None and process.poll() is None:
                await asyncio.to_thread(worker_pool.discard, process, close=False)
        finally:
            try:
                if communication is not None:
                    # Killing the process tree produces EOF. Wait for communicate's Windows
                    # reader threads before closing their file objects.
                    await asyncio.gather(communication, return_exceptions=True)
                if process is not None and (not reuse or not successful):
                    worker_pool.close_streams(process)
            finally:
                _active = False
