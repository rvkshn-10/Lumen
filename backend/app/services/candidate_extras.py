"""V2 fields shared by search, fixed-site inspection, comparison and replay."""

from datetime import datetime
from itertools import pairwise

import numpy as np

from app.models import SearchRequest
from app.services.ephemeris import visibility_metrics
from app.services.events import extract_events, next_events
from app.services.power import power_estimate


def enrich(detail: dict, request: SearchRequest, evaluate, *, sun_distance) -> dict:
    timeline = detail["timeline"]
    for row, distance in zip(timeline, sun_distance, strict=True):
        row["sun_distance_km"] = float(distance)
    detail["power"] = power_estimate(timeline, request.power)
    events = extract_events(timeline, evaluate)
    detail["events"] = events
    instant = request.scrub_time_utc or request.time_range.start_utc
    detail.update(next_events(events, instant))
    times = [datetime.fromisoformat(row["time_utc"]) for row in timeline]
    states = np.array([row["earth_elevation_deg"] - row["earth_horizon_deg"]
                       > request.dte_margin_deg for row in timeline])
    hours = np.array([(b - a).total_seconds() / 3600 for a, b in pairwise(times)])
    fraction, longest, blackout = visibility_metrics(states, hours)
    for row, state in zip(timeline, states, strict=True):
        row["dte_contact"] = bool(state)
    detail["dte"] = {"margin_deg": request.dte_margin_deg, "contact_fraction": fraction,
                     "longest_contact_hours": longest, "longest_blackout_hours": blackout,
                     "definition": "Earth center strictly above terrain plus margin; no RF budget"}
    return detail
