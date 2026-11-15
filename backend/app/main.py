from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api import router
from app.copilot_api import router as copilot_router
from app.coverage_api import router as coverage_router
from app.exploration_api import router as exploration_router
from app.global_api import router as global_router
from app.horizon_api import router as horizon_router
from app.preparation_api import router as preparation_router
from app.scene_api import router as scene_router
from app.services import search_runtime
from app.services.bounded_analysis import worker_environment
from app.settings import settings
from app.v2_api import router as v2_router


@asynccontextmanager
async def lifespan(app):
    runtime = search_runtime.SearchRuntime(worker_environment(), enabled=os.getenv("LUMEN_BACKGROUND_PREPARATION", "1") == "1")
    search_runtime.instance = runtime
    try:
        await runtime.start()
        yield
    finally:
        await runtime.close()
        search_runtime.instance = None


app = FastAPI(
    title="Lumen API",
    lifespan=lifespan,
    version="0.1.0",
    description=(
        "Prototype lunar south-pole comparison interfaces. Results are planning indicators, "
        "not flight-certified mission products."
    ),
)
app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=1)
app.include_router(router)
app.include_router(preparation_router)
app.include_router(exploration_router)
app.include_router(global_router)
app.include_router(coverage_router)
app.include_router(scene_router)
app.include_router(v2_router)
app.include_router(horizon_router)
app.include_router(copilot_router)


if settings.static_dir.exists():
    assets_dir = settings.static_dir / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def frontend(path: str) -> FileResponse:
        root = settings.static_dir.resolve()
        requested = (root / path).resolve()
        if not requested.is_relative_to(root) or path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        if requested.is_file():
            return FileResponse(requested)
        return FileResponse(settings.static_dir / "index.html")
else:

    @app.get("/", include_in_schema=False)
    def root() -> dict[str, str]:
        return {
            "service": "lumen-api",
            "docs": "/docs",
            "frontend": "Run the Vite development server or build apps/web.",
        }
