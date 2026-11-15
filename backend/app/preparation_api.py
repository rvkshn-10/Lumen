"""Optional, leased speculative geometry preparation; never a search prerequisite."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.models import RegionSelection, SearchRequest, TimeRange
from app.services import search_runtime
from app.services.validation import SearchValidationError, validate_search

router = APIRouter(prefix="/api/v1/search/preparation", tags=["preparation"])


class PreparationRequest(BaseModel):
    region: RegionSelection


@router.post("")
async def prepare(payload: PreparationRequest):
    runtime = search_runtime.instance
    if runtime is None:
        return {"state": "unavailable", "message": "Background preparation is unavailable. Submit normally."}
    request = SearchRequest(region=payload.region, time_range=TimeRange(
        start_utc="2028-10-01T00:00:00Z", end_utc="2028-10-02T00:00:00Z"))
    if payload.region.selector_type != "southern_hemisphere" and (
        payload.region.center is None or payload.region.center.latitude_deg <= -87
    ):
        return {"state": "unavailable", "message": "This area uses the existing prepared polar cache. Submit normally."}
    try:
        validate_search(request, hemisphere=True)
        return await runtime.prepare(request.model_dump(mode="json"))
    except SearchValidationError as exc:
        raise HTTPException(422, str(exc)) from exc
    except (OSError, ValueError, KeyError):
        return {"state": "unavailable", "message": "Preparation unavailable. Submit normally."}


@router.post("/yield")
async def yield_preparation():
    runtime = search_runtime.instance
    if runtime:
        await runtime.stop_background()
    return {"state": "ready"}


@router.get("")
async def startup_status():
    runtime = search_runtime.instance
    if runtime is None:
        return {"state": "unavailable", "message": "Preparation unavailable. Submit normally."}
    return runtime.status()


@router.get("/{identifier}")
async def status(identifier: str):
    runtime = search_runtime.instance
    return runtime.status(identifier) if runtime else {"state": "unavailable"}


@router.delete("/{identifier}")
async def cancel(identifier: str):
    runtime = search_runtime.instance
    if runtime:
        await runtime.cancel(identifier)
    return {"state": "unavailable", "message": "Speculative preparation canceled."}
