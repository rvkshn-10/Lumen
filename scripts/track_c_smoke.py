"""Check Track C against a running Lumen build and export UI parity records."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def check(page, url: str) -> list[dict]:
    page.goto(url)
    stages = page.get_by_role("navigation", name="Planning stages")
    expect(stages.get_by_role("button", name="Compare", exact=True)).to_be_disabled()
    page.get_by_role("button", name="Continue to mission", exact=True).click()
    with page.expect_response(
        lambda response: response.url.endswith("/api/v1/candidates/search"),
        timeout=135_000,
    ) as search:
        page.get_by_role("button", name="Find candidate sites", exact=True).click()

    response = search.value
    assert response.ok, f"Search returned HTTP {response.status}"
    result = response.json()
    board = page.get_by_role("region", name="Scenario board")
    expect(board).to_be_visible()
    board.get_by_role("button", name="Engineer view", exact=True).click()
    sites = {site["id"]: site for site in result["candidates"]}
    assert len(sites) >= 2, "The demo window needs two eligible locations"

    comparison = board.get_by_role("region", name="Comparison values", exact=True)
    expect(comparison).to_be_visible()
    rankings = page.get_by_role("region", name="Site rankings", exact=True)
    expect(rankings.get_by_role("listitem")).to_have_count(len(sites))
    assert rankings.evaluate("""rankings => Boolean(
        document.querySelector('.solar-generation').compareDocumentPosition(rankings)
        & Node.DOCUMENT_POSITION_FOLLOWING
    )""")
    for site in result["candidates"][2:4]:
        rankings.get_by_role(
            "button", name=f"Add candidate {site['rank']} to comparison", exact=True
        ).click()
        expect(
            comparison.locator(f'[data-metric="{site["id"]}:earth_visibility_fraction"]')
        ).to_be_visible()

    records = comparison.locator("[data-metric]").evaluate_all(
        """(elements, start) => elements.map(element => ({
          metric: element.dataset.metric, raw: element.dataset.raw,
          start_utc: start, display: element.textContent.trim()
        }))""",
        result["request"]["time_range"]["start_utc"],
    )
    assert len(records) >= 3 * min(4, len(sites))

    board.get_by_role("tab", name="Timeline", exact=True).click()
    clock = board.get_by_role("slider", name="Compare time")
    for _ in range(10):
        clock.press("ArrowRight")
    board.locator("summary").filter(has_text="Upcoming cutoffs").click()
    cutoffs = board.get_by_role("region", name="Upcoming cutoffs", exact=True)
    expect(cutoffs).to_be_visible()
    records += cutoffs.locator("[data-metric]").evaluate_all(
        """elements => elements.map(element => ({
          metric: element.dataset.metric, raw: element.dataset.raw,
          start_utc: element.closest("tr").dataset.scenarioStart,
          display: element.textContent.trim()
        }))"""
    )
    for record in records:
        site_id, key = record["metric"].rsplit(":", 1)
        site = sites[site_id]
        if key in ("sunset", "earthset"):
            assert any(
                event["type"] == key and event["time_utc"] == record["raw"]
                for event in site["events"]
            ), record
            continue
        raw = site["power"][key] if key == "energy_wh" else site["metrics"][key]
        assert math.isclose(float(record["raw"]), raw, abs_tol=1e-12), record
        shown, units, tolerance = raw, " h", 0.05
        if key.endswith("_fraction"):
            shown, units = raw * 100, "%"
        if key == "energy_wh":
            shown, units, tolerance = raw / 1000, " kWh", 0.005
        assert record["display"].endswith(units), record
        assert abs(float(record["display"].removesuffix(units)) - shown) <= tolerance + 1e-12, record
    return records


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--channel", help="Use an installed browser, for example chrome")
    options = parser.parse_args()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel=options.channel)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        records = check(page, options.url)
        browser.close()
    if options.output:
        options.output.write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8")
    print(f"Checked {len(records)} values against the search response.")


if __name__ == "__main__":
    main()
