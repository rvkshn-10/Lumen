"""Compare the OpenVINO model with a Lumen analysis export or contract fixture."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.services.horizon_review import HorizonReview, review_horizon


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export", type=Path)
    args = parser.parse_args()
    data = json.loads(args.export.read_text(encoding="utf-8"))
    total = disagreements = 0
    near_labels = near_disagreements = outside_labels = outside_disagreements = 0
    for site in data["candidates"]:
        timeline = site["timeline"]
        if not timeline:
            continue
        print(site["id"])
        for start in range(0, len(timeline), 2048):
            review = HorizonReview(samples=timeline[start : start + 2048])
            outcome = review_horizon(review.samples)
            result = outcome.model_dump(
                exclude={"disagreement_indices", "disagreements"}
            )
            print(json.dumps(result, indent=2))
            for item in outcome.disagreements:
                print(
                    f"  {review.samples[item.sample_index].time_utc.isoformat()} "
                    f"{item.body}: {item.clearance_deg:+.4f}°, "
                    f"physics={'visible' if item.physics_visible else 'blocked'}, "
                    f"OpenVINO={'visible' if item.model_visible else 'blocked'}"
                )
            near_labels += outcome.near_horizon.labels
            near_disagreements += outcome.near_horizon.disagreements
            outside_labels += outcome.outside_horizon_band.labels
            outside_disagreements += outcome.outside_horizon_band.disagreements
            total += outcome.samples
            disagreements += len(outcome.disagreement_indices)
    if total:
        print(f"Both labels agree at {total - disagreements:,}/{total:,} timestamps.")
        print(f"Near horizon: {near_disagreements:,}/{near_labels:,} labels differ.")
        print(
            f"Outside the band: {outside_disagreements:,}/{outside_labels:,} labels differ."
        )
    else:
        parser.error("The export has no candidate timeline samples.")


if __name__ == "__main__":
    main()
