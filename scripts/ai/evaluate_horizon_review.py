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
    for site in data["candidates"]:
        timeline = site["timeline"]
        if not timeline:
            continue
        print(site["id"])
        for start in range(0, len(timeline), 2048):
            review = HorizonReview(samples=timeline[start : start + 2048])
            outcome = review_horizon(review.samples)
            result = outcome.model_dump(exclude={"disagreement_indices"})
            print(json.dumps(result, indent=2))
            for index in outcome.disagreement_indices:
                print("  Difference:", review.samples[index].time_utc.isoformat())
            total += outcome.samples
            disagreements += len(outcome.disagreement_indices)
    if total:
        print(f"Both labels agree at {total - disagreements:,}/{total:,} timestamps.")
    else:
        parser.error("The export has no candidate timeline samples.")


if __name__ == "__main__":
    main()
