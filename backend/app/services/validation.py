from __future__ import annotations

from datetime import UTC, datetime, timedelta
from math import pi

import numpy as np

from app.models import (
    Coordinate,
    Preferences,
    SearchRequest,
    SearchValidationResponse,
    SelectorType,
)
from app.services.dataset import DataUnavailable, dataset
from app.services.proximity import feature_catalog
from app.services.repository import is_tiled, load_area, release_metadata
from app.services.search_limits import public_limits
from app.settings import settings

DEFAULT_PREFERENCES = Preferences(
    illumination=0.4,
    earth_visibility=0.4,
    terrain_safety=0.20,
    science_proximity=0,
)
VALID_START = datetime(2025, 1, 1, tzinfo=UTC)
VALID_END = datetime(2036, 1, 1, tzinfo=UTC)
MAXIMUM_WINDOW = timedelta(days=31)
CANDIDATE_SPACING_KM = 0.5
SUPPORTED_CAP_AREA_KM2 = 25_900


class SearchValidationError(ValueError):
    pass


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise SearchValidationError("Dates must include a UTC offset.")
    return value.astimezone(UTC)


def normalize_preferences(preferences: Preferences) -> tuple[Preferences, list[str]]:
    values = preferences.model_dump()
    total = sum(values.values())
    if total == 0:
        return DEFAULT_PREFERENCES, ["All weights were zero; documented defaults were applied."]

    return Preferences(**{key: value / total for key, value in values.items()}), []


def _estimate_candidates(request: SearchRequest) -> int:
    if is_tiled(settings.data_root):
        if request.region.selector_type == SelectorType.full_supported_region:
            return release_metadata(settings.data_root)["candidate_count"]
        return len(load_area(settings.data_root, request.region)[1]["ids"])
    try:
        _, arrays = dataset(settings.data_root)
        if request.region.selector_type == SelectorType.full_supported_region:
            return len(arrays["lat_deg"])
        if request.region.center and request.region.search_radius_km:
            lat, lon = np.deg2rad(arrays["lat_deg"]), np.deg2rad(arrays["lon_deg"])
            clat, clon = np.deg2rad(
                [request.region.center.latitude_deg, request.region.center.longitude_deg_east]
            )
            hav = (
                np.sin((lat - clat) / 2) ** 2
                + np.cos(lat) * np.cos(clat) * np.sin((lon - clon) / 2) ** 2
            )
            distance = 3474.8 * np.arcsin(np.sqrt(np.clip(hav, 0, 1)))
            return int((distance <= request.region.search_radius_km).sum())
    except DataUnavailable:
        pass
    if request.region.selector_type == SelectorType.full_supported_region:
        area_km2 = SUPPORTED_CAP_AREA_KM2
    elif request.region.search_radius_km is not None:
        area_km2 = pi * request.region.search_radius_km**2
    else:
        area_km2 = 0
    return round(area_km2 / CANDIDATE_SPACING_KM**2)


def hemisphere_candidate_count(request):
    if request.region.selector_type == SelectorType.southern_hemisphere:
        from app.services.hemisphere_survey import grid

        return len(grid()[0])
    return round(pi * request.region.search_radius_km**2 / .25)


def validate_search(request: SearchRequest, *, point_only: bool = False, hemisphere: bool = False) -> SearchValidationResponse:
    region_assumptions: list[str] = []
    if request.region.selector_type == SelectorType.feature_radius:
        try:
            release_metadata(settings.data_root) if is_tiled(settings.data_root) else dataset(settings.data_root)
        except DataUnavailable as exc:
            raise SearchValidationError(
                "Named-region resolution requires an unavailable approved-feature dataset."
            ) from exc
        approved = {row["id"]: row for row in feature_catalog(settings.data_root)["features"]}
        feature = approved.get(request.region.resolved_feature_id)
        if feature is None:
            raise SearchValidationError("Unknown or unavailable approved region feature ID.")
        request.region.center = Coordinate(
            latitude_deg=feature["latitude_deg"], longitude_deg_east=feature["longitude_deg_east"]
        )
        request.region.input_text = feature["name"]
        region_assumptions.append(
            f"Named-region center resolved from approved IAU feature {feature['id']} ({feature['name']}); supplied coordinates are replaced."
        )
    if request.region.selector_type == SelectorType.polygon:
        raise SearchValidationError("Polygon selection is not supported in this MVP; use a circle.")
    if hemisphere:
        if request.region.selector_type not in (SelectorType.circle, SelectorType.southern_hemisphere) or (request.region.selector_type == SelectorType.circle and request.region.center is None):
            raise SearchValidationError("Southern terrain searches require a circle.")
        if request.region.center and request.region.center.latitude_deg > 0:
            raise SearchValidationError("Choose a southern hemisphere center.")
        if request.region.search_radius_km is not None and request.region.search_radius_km > public_limits()["maximum_radius_km"]:
            raise SearchValidationError(f"Southern terrain searches allow up to {public_limits()['maximum_radius_km']} km radius.")
        if request.hard_constraints.science_feature_ids or request.hard_constraints.maximum_distance_to_psr_km is not None:
            raise SearchValidationError("PSR and feature-proximity constraints are unavailable for hemisphere terrain.")
    if not hemisphere and request.region.center and request.region.center.latitude_deg > -87:
        raise SearchValidationError("Search centers must be in the lunar south-pole cap (87–90°S).")
    start = _as_utc(request.time_range.start_utc)
    end = _as_utc(request.time_range.end_utc)
    request.time_range.start_utc, request.time_range.end_utc = start, end
    if request.scrub_time_utc is not None:
        request.scrub_time_utc = _as_utc(request.scrub_time_utc)
        if not start <= request.scrub_time_utc <= end:
            raise SearchValidationError("Scrub time must be inside the mission window.")

    if start >= end:
        raise SearchValidationError("The mission start must be earlier than the mission end.")
    if end - start > MAXIMUM_WINDOW:
        raise SearchValidationError("Mission windows are limited to 31 days in the prototype.")
    if start < VALID_START or end > VALID_END:
        raise SearchValidationError("Mission dates must fall within the validated 2025–2035 range.")

    constraints = request.hard_constraints
    limits = public_limits()
    if hemisphere and end-start > timedelta(days=7):
        raise SearchValidationError("Southern terrain searches allow up to 7 days.")
    if not hemisphere and is_tiled(settings.data_root) and not point_only:
        if request.region.selector_type == SelectorType.full_supported_region:
            if start != datetime.fromisoformat(limits["full_region_start_utc"]) or end != datetime.fromisoformat(limits["full_region_end_utc"]):
                raise SearchValidationError("The full cap demo uses exactly October 1–31, 2028; choose a local circle for other dates.")
        elif request.region.search_radius_km > limits["maximum_radius_km"] or end-start > timedelta(days=limits["maximum_live_days"]):
            raise SearchValidationError(f"Live cap searches allow up to {limits['maximum_radius_km']} km radius and {limits['maximum_live_days']} days; reduce the radius or shorten the window, or use the fixed full-cap demo for broader analysis.")
    if constraints.maximum_distance_to_psr_km is not None:
        try:
            _, arrays = ({}, {}) if is_tiled(settings.data_root) else dataset(settings.data_root)
        except DataUnavailable as exc:
            raise SearchValidationError("PSR proximity requires an unavailable dataset.") from exc
        if "distance_psr_km" not in arrays:
            raise SearchValidationError("PSR proximity requires an unavailable dataset.")
    if (
        constraints.maximum_distance_to_science_feature_km is not None
        and not constraints.science_feature_ids
    ):
        raise SearchValidationError(
            "Select at least one approved feature for a science-distance constraint."
        )
    if constraints.science_feature_ids:
        try:
            release_metadata(settings.data_root) if is_tiled(settings.data_root) else dataset(settings.data_root)
        except DataUnavailable as exc:
            raise SearchValidationError(
                "Approved-feature proximity requires an unavailable dataset."
            ) from exc
        available = {row["id"] for row in feature_catalog(settings.data_root)["features"]}
        unknown = set(constraints.science_feature_ids) - available
        if unknown:
            raise SearchValidationError(
                f"Unknown or unavailable approved feature IDs: {', '.join(sorted(unknown))}"
            )
    if (
        constraints.minimum_elevation_m is not None
        and constraints.maximum_elevation_m is not None
        and constraints.minimum_elevation_m > constraints.maximum_elevation_m
    ):
        raise SearchValidationError("Minimum elevation cannot exceed maximum elevation.")

    duration_hours = (end - start).total_seconds() / 3600
    continuous_requirements = {
        "minimum continuous sunlight": constraints.minimum_continuous_sunlight_hours,
        "minimum continuous communication": constraints.minimum_continuous_communication_hours,
    }
    for label, value in continuous_requirements.items():
        if value is not None and value > duration_hours:
            raise SearchValidationError(f"{label.title()} cannot exceed the mission duration.")

    normalized, assumptions = normalize_preferences(request.preferences)
    assumptions = region_assumptions + assumptions
    warnings: list[str] = []
    if max(normalized.model_dump().values()) == 1:
        warnings.append("One category has 100% weight; all other preferences are ignored.")

    return SearchValidationResponse(
        valid=True,
        normalized_preferences=normalized,
        assumptions=assumptions,
        warnings=warnings,
        estimated_candidate_count=hemisphere_candidate_count(request) if hemisphere else _estimate_candidates(request),
    )
