"""Public limits remain locked until Intel and Mac speed/equivalence gates pass."""

TIERS = {
    "detailed": {
        "maximum_radius_km": 5,
        "maximum_live_days": 7,
        "target_radius_km": 15,
        "target_days": 14,
    },
    "mission": {"enabled": False, "target_radius_km": 50, "target_days": 30},
    "regional": {"enabled": False, "target_radius_km": 100, "target_days": 30},
    "whole": {"precomputed_only": True},
}
FULL_REGION_START = "2028-10-01T00:00:00Z"
FULL_REGION_END = "2028-10-31T00:00:00Z"


def public_limits():
    return {
        "maximum_radius_km": TIERS["detailed"]["maximum_radius_km"],
        "maximum_live_days": TIERS["detailed"]["maximum_live_days"],
        "full_region_start_utc": FULL_REGION_START,
        "full_region_end_utc": FULL_REGION_END,
    }
