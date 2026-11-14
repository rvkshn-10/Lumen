"""Check Track C against a running Lumen build and export UI parity records."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def check(page, url: str) -> list[dict]:
    page.goto(url)
    page.get_by_role("button", name="Continue to mission").click()
    page.get_by_role("button", name="Review mission", exact=True).click()
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
    sites = {site["id"]: site for site in result["candidates"]}
    assert len(sites) >= 2, "The demo window needs two eligible locations"
    for checkbox in board.get_by_role("checkbox").all():
        checkbox.check()

    expect(board.get_by_role("region", name="Compare selected scenarios")).to_be_visible()
    clock = board.get_by_role("slider", name="Compare time")
    for _ in range(10):
        clock.press("ArrowRight")

    records = board.locator(".scenario-table [data-metric]").evaluate_all(
        """elements => elements.map(element => ({
          metric: element.dataset.metric, raw: element.dataset.raw,
          start_utc: element.closest("tr").dataset.scenarioStart,
          display: element.textContent.trim()
        }))"""
    )
    assert len(records) >= 3 * min(4, len(sites))
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
