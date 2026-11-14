"""Bracketed geometric rise/set transitions, refined without changing sampled metrics."""

from datetime import datetime
from itertools import pairwise


def extract_events(timeline, evaluate, *, tolerance_seconds=60):
    events = []
    for body, key in (("sun", "sun_visible"), ("earth", "earth_visible")):
        for before, after in pairwise(timeline):
            if before[key] == after[key]:
                continue
            low, high = (datetime.fromisoformat(row["time_utc"]) for row in (before, after))
            while (high - low).total_seconds() > tolerance_seconds:
                mid = low + (high - low) / 2
                if evaluate(mid, body) == before[key]:
                    low = mid
                else:
                    high = mid
            events.append({"type": f"{body}{'rise' if after[key] else 'set'}",
                           "time_utc": (low + (high - low) / 2).isoformat(),
                           "uncertainty_minutes": (high - low).total_seconds() / 120})
    return sorted(events, key=lambda row: (row["time_utc"], row["type"]))


def next_events(events, instant):
    """None means no next event in the analyzed window, never continuous visibility."""
    return {f"next_{kind}": next((event for event in events if event["type"] == kind
                                     and datetime.fromisoformat(event["time_utc"]) > instant), None)
            for kind in ("sunset", "earthset")}
