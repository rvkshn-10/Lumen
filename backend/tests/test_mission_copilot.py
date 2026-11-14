from datetime import UTC, datetime

from fastapi.testclient import TestClient
from test_validation import request_for

from app.main import app
from app.services import mission_copilot as copilot


def base_request():
    base = request_for(datetime(2028, 10, 1, tzinfo=UTC), datetime(2028, 10, 8, tzinfo=UTC))
    base.hard_constraints.minimum_earth_visibility_fraction = 0.55
    base.scrub_time_utc = datetime(2028, 10, 2, tzinfo=UTC)
    return base


def test_disabled_copilot_needs_no_runtime_or_model(monkeypatch):
    monkeypatch.delenv("LUMEN_COPILOT_MODEL_DIR", raising=False)
    client = TestClient(app)
    assert client.get("/api/v1/ai/copilot-status").json() == {"available": False}
    response = client.post(
        "/api/v1/ai/mission-draft",
        json={"base": base_request().model_dump(mode="json"), "brief": "near Shackleton"},
    )
    assert response.status_code == 503


def test_draft_resolves_gazetteer_and_preserves_existing_settings(monkeypatch):
    monkeypatch.setattr(
        copilot,
        "_generate",
        lambda *args, **kwargs: copilot.MissionIntent(priority="sunlight"),
    )
    base = base_request()
    response = TestClient(app).post(
        "/api/v1/ai/mission-draft",
        json={
            "base": base.model_dump(mode="json"),
            "brief": "Within 3 km of Shackleton from 2028-10-05 to 2028-10-09, "
            "slope below 7 degrees, favor sunlight.",
        },
    )
    assert response.status_code == 200
    draft = copilot.MissionDraft.model_validate(response.json())
    assert draft.engine == "openvino-genai"
    assert not draft.errors
    assert draft.request.region.resolved_feature_id == "iau-5450"
    assert draft.request.region.center.latitude_deg < -89
    assert draft.request.region.search_radius_km == 3
    assert draft.request.time_range.start_utc == datetime(2028, 10, 5, tzinfo=UTC)
    assert draft.request.time_range.end_utc == datetime(2028, 10, 9, tzinfo=UTC)
    assert draft.request.scrub_time_utc is None
    assert draft.request.hard_constraints.maximum_slope_deg == 7
    assert draft.request.hard_constraints.minimum_earth_visibility_fraction == 0.55
    assert draft.request.preferences.illumination > draft.request.preferences.earth_visibility
    assert draft.request.power == base.power


def test_unknown_landmark_and_unrelated_quantities_leave_settings_unchanged(monkeypatch):
    monkeypatch.setattr(
        copilot,
        "_generate",
        lambda *args, **kwargs: copilot.MissionIntent(priority="earth"),
    )
    original = base_request()
    draft = copilot.build_draft(
        copilot.MissionDraftInput(
            base=original,
            brief="Within 3 km of Fake Crater, east of Shackleton. Slope above 7 degrees, "
            "up to 10 hours of continuous sunlight.",
        )
    )
    assert len(draft.errors) == 1
    assert draft.changes == []
    assert draft.request == original


def test_explicit_priority_beats_a_conflicting_model_choice(monkeypatch):
    monkeypatch.setattr(
        copilot,
        "_generate",
        lambda *args, **kwargs: copilot.MissionIntent(priority="terrain"),
    )
    draft = copilot.build_draft(
        copilot.MissionDraftInput(
            base=base_request(),
            brief="Find sites near Shackleton with gentle terrain and prioritize continuous sunlight.",
        )
    )
    assert "Ranking priority: Sunlight." in draft.changes
    assert draft.request.hard_constraints.minimum_continuous_sunlight_hours is None
    assert any("uninterrupted window" in assumption for assumption in draft.assumptions)


def test_model_selects_a_grounded_priority_when_multiple_are_requested(monkeypatch):
    proposed = "earth"

    def classify(*args, **kwargs):
        return copilot.MissionIntent(priority=proposed)

    monkeypatch.setattr(copilot, "_generate", classify)
    payload = copilot.MissionDraftInput(
        base=base_request(),
        brief="Optimize for sunlight and reliable ground contact.",
    )
    earth = copilot.build_draft(payload)
    proposed = "sunlight"
    sun = copilot.build_draft(payload)
    assert not earth.errors and not sun.errors
    assert earth.request.preferences.earth_visibility > earth.request.preferences.illumination
    assert sun.request.preferences.illumination > sun.request.preferences.earth_visibility


def test_draft_is_checked_by_the_existing_search_validator(monkeypatch):
    monkeypatch.setattr(
        copilot,
        "_generate",
        lambda *args, **kwargs: copilot.MissionIntent(priority="unchanged"),
    )
    draft = copilot.build_draft(
        copilot.MissionDraftInput(
            base=base_request(),
            brief="2028-10-05 to 2028-10-06 with at least 35 hours of continuous sunlight.",
        )
    )
    assert not draft.errors
    assert draft.validation_errors == [
        "Minimum Continuous Sunlight cannot exceed the mission duration."
    ]


def test_explanation_focus_cannot_invent_values_or_claim_a_tied_winner(monkeypatch):
    def choose_focus(system, content, output_type, **options):
        assert "Site A" not in content
        assert "Site B" not in content
        return output_type(focus="darkness")

    monkeypatch.setattr(copilot, "_generate", choose_focus)
    response = TestClient(app).post(
        "/api/v1/ai/mission-explanation",
        json={
            "candidates": [
                {
                    "name": "Site A",
                    "sunlight_fraction": 0.82,
                    "earth_visibility_fraction": 0.71,
                    "longest_darkness_hours": 6,
                },
                {
                    "name": "Site B",
                    "sunlight_fraction": 0.82,
                    "earth_visibility_fraction": 0.83,
                    "longest_darkness_hours": 8.5,
                },
            ]
        },
    )
    assert response.status_code == 200
    explanation = response.json()["explanation"]
    assert explanation.startswith("Site A had the shortest modeled stretch of continuous darkness")
    assert "Site A: 6.0 h, Site B: 8.5 h" in explanation
    assert "The options tie on sunlight fraction" in explanation
    assert "Site B: 83.0%, Site A: 71.0%" in explanation


def test_balanced_explanation_leads_with_varying_metric_if_model_picks_a_tie(monkeypatch):
    monkeypatch.setattr(
        copilot, "_generate", lambda *args, **kwargs: copilot.ExplanationFocus(focus="sunlight")
    )
    result = copilot.explain_results(
        copilot.MissionExplanationInput(
            candidates=[
                copilot.MissionCandidate(
                    name="Site A",
                    sunlight_fraction=0.82,
                    earth_visibility_fraction=0.71,
                    longest_darkness_hours=6,
                ),
                copilot.MissionCandidate(
                    name="Site B",
                    sunlight_fraction=0.8201,
                    earth_visibility_fraction=0.83,
                    longest_darkness_hours=6,
                ),
            ]
        )
    )
    assert result.explanation.startswith("Site B had the highest modeled Earth visibility")
    assert "The options tie on sunlight fraction" in result.explanation
