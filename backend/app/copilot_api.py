from fastapi import APIRouter, HTTPException

from app.services.mission_copilot import (
    CopilotBusy,
    CopilotOutputError,
    CopilotStatus,
    CopilotUnavailable,
    MissionDraft,
    MissionDraftInput,
    MissionExplanation,
    MissionExplanationInput,
    build_draft,
    copilot_available,
    explain_results,
)

router = APIRouter(prefix="/api/v1/ai")


def _http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, CopilotBusy):
        return HTTPException(status_code=429, detail=str(exc), headers={"Retry-After": "3"})
    if isinstance(exc, CopilotUnavailable):
        return HTTPException(status_code=503, detail=str(exc))
    return HTTPException(status_code=502, detail=str(exc))


@router.get("/copilot-status", response_model=CopilotStatus)
def copilot_status() -> CopilotStatus:
    return CopilotStatus(available=copilot_available())


@router.post("/mission-draft", response_model=MissionDraft)
def mission_draft(payload: MissionDraftInput) -> MissionDraft:
    try:
        return build_draft(payload)
    except (CopilotBusy, CopilotOutputError, CopilotUnavailable) as exc:
        raise _http_error(exc) from exc


@router.post("/mission-explanation", response_model=MissionExplanation)
def mission_explanation(payload: MissionExplanationInput) -> MissionExplanation:
    try:
        return explain_results(payload)
    except (CopilotBusy, CopilotOutputError, CopilotUnavailable) as exc:
        raise _http_error(exc) from exc
