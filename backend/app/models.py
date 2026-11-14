from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class SelectorType(StrEnum):
    full_supported_region = "full_supported_region"
    feature_radius = "feature_radius"
    circle = "circle"
    polygon = "polygon"


class Coordinate(StrictModel):
    latitude_deg: float = Field(ge=-90, le=90)
    longitude_deg_east: float = Field(ge=-180, lt=180)


class RegionSelection(StrictModel):
    selector_type: SelectorType
    input_text: str | None = Field(default=None, max_length=500)
    resolved_feature_id: str | None = Field(default=None, max_length=200)
    center: Coordinate | None = None
    search_radius_km: float | None = Field(default=None, ge=1, le=50)

    @model_validator(mode="after")
    def validate_spatial_selector(self) -> RegionSelection:
        if self.selector_type == SelectorType.circle and (
            self.center is None or self.search_radius_km is None
        ):
            raise ValueError("Circle searches require a center and radius.")
        if self.selector_type == SelectorType.feature_radius and (
            not self.resolved_feature_id or self.search_radius_km is None
        ):
            raise ValueError("Feature-radius searches require an approved feature ID and radius.")
        return self


class TimeRange(StrictModel):
    start_utc: datetime
    end_utc: datetime


class HardConstraints(StrictModel):
    maximum_slope_deg: float | None = Field(default=None, ge=0, le=90)
    maximum_roughness_m: float | None = Field(default=None, ge=0)
    minimum_elevation_m: float | None = None
    maximum_elevation_m: float | None = None
    minimum_illumination_fraction: float | None = Field(default=None, ge=0, le=1)
    minimum_continuous_sunlight_hours: float | None = Field(default=None, ge=0)
    maximum_continuous_darkness_hours: float | None = Field(default=None, ge=0)
    minimum_earth_visibility_fraction: float | None = Field(default=None, ge=0, le=1)
    minimum_continuous_communication_hours: float | None = Field(default=None, ge=0)
    maximum_continuous_blackout_hours: float | None = Field(default=None, ge=0)
    maximum_distance_to_psr_km: float | None = Field(default=None, ge=0)
    maximum_distance_to_science_feature_km: float | None = Field(default=None, ge=0)
    science_feature_ids: list[str] = Field(default_factory=list, max_length=20)


class Preferences(StrictModel):
    illumination: float = Field(default=0.4, ge=0)
    earth_visibility: float = Field(default=0.4, ge=0)
    terrain_safety: float = Field(default=0.20, ge=0)
    science_proximity: float = Field(default=0, ge=0)


class PowerSettings(StrictModel):
    area_m2: float = Field(default=1, gt=0, le=10000)
    efficiency: float = Field(default=0.30, gt=0, le=1)
    load_w: float = Field(default=150, ge=0, le=1e7)
    capacity_wh: float = Field(default=2000, gt=0, le=1e9)
    start_soc: float = Field(default=1, ge=0, le=1)


class SearchRequest(StrictModel):
    region: RegionSelection
    time_range: TimeRange
    hard_constraints: HardConstraints = Field(default_factory=HardConstraints)
    preferences: Preferences = Field(default_factory=Preferences)
    dte_margin_deg: float = Field(default=2, ge=0, le=90)
    power: PowerSettings = Field(default_factory=PowerSettings)
    scrub_time_utc: datetime | None = None


class SearchValidationResponse(StrictModel):
    valid: bool
    normalized_preferences: Preferences
    assumptions: list[str]
    warnings: list[str]
    estimated_candidate_count: int = Field(ge=0)


class ScenarioRequest(StrictModel):
    request: SearchRequest
    site_id: str = Field(min_length=1, max_length=100)
    delay_hours: float = Field(default=12, ge=-168, le=168)
    offset_radius_m: float = Field(default=500, ge=0, le=2000)
    include_sampling_sensitivity: bool = True


class CompareSite(StrictModel):
    site_id: str | None = Field(default=None, min_length=1, max_length=100)
    latitude_deg: float | None = Field(default=None, ge=-90, le=90)
    longitude_deg_east: float | None = Field(default=None, ge=-180, lt=180)

    @model_validator(mode="after")
    def one_location(self):
        if self.site_id is not None:
            if self.latitude_deg is not None or self.longitude_deg_east is not None:
                raise ValueError("Supply a site_id OR both coordinates.")
        elif self.latitude_deg is None or self.longitude_deg_east is None:
            raise ValueError("Supply a site_id OR both coordinates.")
        return self


class CompareRequest(StrictModel):
    sites: list[CompareSite] = Field(min_length=1, max_length=4)
    time_range: TimeRange
    hard_constraints: HardConstraints = Field(default_factory=HardConstraints)
    preferences: Preferences = Field(default_factory=Preferences)
    dte_margin_deg: float = Field(default=2, ge=0, le=90)
    power: PowerSettings = Field(default_factory=PowerSettings)
    scrub_time_utc: datetime | None = None

    @model_validator(mode="after")
    def unique_sites(self):
        identities = [(s.site_id, s.latitude_deg, s.longitude_deg_east) for s in self.sites]
        if len(set(identities)) != len(identities):
            raise ValueError("Choose distinct locations for comparison.")
        return self
