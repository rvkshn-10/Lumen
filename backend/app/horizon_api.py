from fastapi import APIRouter, HTTPException

from app.services.horizon_review import (
    HorizonResult,
    HorizonReview,
    RuntimeUnavailable,
    review_horizon,
)

router = APIRouter(prefix="/api/v1/ai")


@router.post("/horizon-review", response_model=HorizonResult)
def horizon_review(payload: HorizonReview) -> HorizonResult:
    try:
        return review_horizon(payload.samples)
    except RuntimeUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
