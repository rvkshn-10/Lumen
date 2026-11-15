"""Stable limits plus an explicit Intel development radius; no latency qualification implied."""

import os

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
    # User-authorized Intel-only development, separately enabled from stable tier gates.
    radius = int(os.getenv("LUMEN_MAXIMUM_RADIUS_KM", "5"))
    if radius not in (5, 10, 15):
        raise ValueError("LUMEN_MAXIMUM_RADIUS_KM must be 5, 10 or 15")
    return {
        "maximum_radius_km": radius,
        "maximum_live_days": TIERS["detailed"]["maximum_live_days"],
        "full_region_start_utc": FULL_REGION_START,
        "full_region_end_utc": FULL_REGION_END,
    }
