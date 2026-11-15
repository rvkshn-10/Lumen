"""Exercise the merged V2 workflows and export independent UI/scene parity inputs."""

from __future__ import annotations

import argparse
import json
import random
import re
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def site_picker(board, letter):
    controls = board.get_by_role("group", name="Sites to compare", exact=True)
    return controls.get_by_role("combobox", name=f"Site {letter}", exact=True)


def choose_candidate(picker, rank):
    option = picker.get_by_role("option", name=re.compile(rf"^Candidate {rank}\b"))
    picker.select_option(value=option.get_attribute("value"))


def add_candidate(board, letter, rank):
    board.get_by_role("button", name="Add a site", exact=True).click()
    choose_candidate(site_picker(board, letter), rank)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--channel", default="chrome")
    parser.add_argument("--output", type=Path, default=Path("data/cache/v2-integration"))
    options = parser.parse_args()
    options.output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel=options.channel)
        errors = []
        page = browser.new_page(viewport={"width": 1440, "height": 1000}, reduced_motion="reduce")
        actual = []

        def capture_search(route):
            # Preserve the real response before Chrome evicts its large body.
            response = route.fetch(timeout=135000)
            assert response.ok, response.text()
            actual.append(response.json())
            route.fulfill(response=response)

        page.route("**/api/v1/candidates/search", capture_search)
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(options.url.rstrip("/") + "/?parity")
        proceed = page.get_by_role("button", name="Continue to mission", exact=True)
        expect(proceed).to_be_enabled()
        page.locator(".area-editor > summary").click()
        page.get_by_role("combobox", name="Area selection", exact=True).select_option("full_supported_region")
        proceed.click()
        page.get_by_role("button", name="Apply October 2028 demo window").click()
        page.get_by_role("button", name="Review mission", exact=True).click()
        with page.expect_response(lambda response: response.url.endswith("/candidates/search"), timeout=135000) as pending:
            page.get_by_role("button", name="Find candidate sites", exact=True).click()
        result = actual[0]
        assert pending.value.ok and len(result["candidates"]) >= 4
        (options.output / "analysis.json").write_text(json.dumps(result), encoding="utf-8")
        board = page.get_by_role("region", name="Scenario board", exact=True)
        expect(board).to_be_visible()
        comparison = board.get_by_role("region", name="Comparison values", exact=True)
        site_a, site_b = site_picker(board, "A"), site_picker(board, "B")
        original_a, original_b = site_a.input_value(), site_b.input_value()
        first, replacement = result["candidates"][0], result["candidates"][2]
        first_metric = comparison.locator(f'[data-metric="{first["id"]}:earth_visibility_fraction"]')
        replacement_metric = comparison.locator(f'[data-metric="{replacement["id"]}:earth_visibility_fraction"]')
        choose_candidate(site_a, replacement["rank"])
        expect(first_metric).to_have_count(0)
        expect(replacement_metric).to_be_visible()
        assert float(replacement_metric.get_attribute("data-raw")) == replacement["metrics"]["earth_visibility_fraction"]
        site_a.select_option(value=original_a)
        expect(first_metric).to_be_visible()
        expect(replacement_metric).to_have_count(0)
        site_b.select_option(value=original_a)
        expect(site_a).to_have_value(original_b)
        expect(site_b).to_have_value(original_a)
        site_b.select_option(value=original_b)
        expect(site_a).to_have_value(original_a)
        expect(site_b).to_have_value(original_b)

        for letter, candidate in zip("CD", result["candidates"][2:4]):
            add_candidate(board, letter, candidate["rank"])
        expect(comparison).to_be_visible()
        expect(board.locator("[data-solar-trace]")).to_have_count(4)
        expect(board.get_by_role("button", name="Add a site", exact=True)).to_have_count(0)
        values = comparison.locator("[data-metric]").evaluate_all("""elements => elements.map(el => {
            const key = el.dataset.metric.split(':').at(-1);
            return {key: el.dataset.metric, raw: Number(el.dataset.raw), displayed: el.textContent.trim(),
                scale: key.endsWith('_fraction') ? 100 : key === 'energy_wh' ? 0.001 : 1,
                decimals: key === 'energy_wh' ? 2 : 1};
        })""")
        assert len(values) == 16
        (options.output / "ui.json").write_text(json.dumps({"values": values}), encoding="utf-8")
        page.screenshot(path=str(options.output / "desktop.png"), full_page=True)

        board.get_by_role("tab", name="Timeline", exact=True).click()
        board.locator("summary").filter(has_text="Upcoming cutoffs").click()
        expect(board.get_by_role("region", name="Upcoming cutoffs", exact=True)).to_be_visible()
        board.locator("summary").filter(has_text="Shared terrain at the compare clock").click()
        page.wait_for_function("window.__lumenScene?.dump().samples.filter(s => s.view === 'terrain-pin').length === 4")
        slider = board.get_by_role("slider", name="Compare time")
        maximum = int(slider.get_attribute("max"))
        samples = []
        rng = random.Random(20261114)
        for _ in range(10):
            slider.evaluate("""(el, value) => {
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(value));
                el.dispatchEvent(new Event('input', {bubbles:true}));
                el.dispatchEvent(new Event('change', {bubbles:true}));
            }""", rng.randrange(maximum))
            page.wait_for_timeout(150)
            samples.extend(page.evaluate("window.__lumenScene.dump().samples"))
        (options.output / "scene.json").write_text(json.dumps({"samples": samples}), encoding="utf-8")
        board.get_by_role("combobox", name="Terrain view", exact=True).select_option(label="2D map")
        for letter in "ABCD":
            expect(board.get_by_role("button", name=f"Inspect Site {letter}", exact=True)).to_be_visible()
        # Date duplication must obtain new live science, not duplicate a response.
        board.get_by_role("tab", name="Overview", exact=True).click()
        scenario_editor = board.locator(".compare-management > summary")
        scenarios = board.get_by_role("region", name="Scenarios", exact=True)
        if not scenarios.is_visible():
            scenario_editor.click()
        scenario_rows = board.locator(".compare-scenario-list li")
        initial_count = scenario_rows.count()
        board.locator(".compare-row-menu > summary").first.click()
        board.get_by_role("button", name="Duplicate & change date", exact=True).click()
        board.get_by_label(re.compile("^New start date for ")).fill("2028-10-02T00:00")
        with page.expect_response(lambda response: response.url.endswith("/analysis"), timeout=135000) as duplicate:
            board.get_by_role("button", name="Analyze the new date", exact=True).click()
        assert duplicate.value.ok, duplicate.value.text()
        expect(scenario_rows).to_have_count(initial_count + 1)
        detail = duplicate.value.json()
        if detail["constraint_status"]["passes"] is False:
            expect(board.get_by_text("Falls short of mission limits", exact=True)).to_be_visible()
        # Compact screen: the added site remains editable and removable.
        page.set_viewport_size({"width": 390, "height": 844})
        board.get_by_role("button", name="Remove Site D", exact=True).click()
        expect(site_picker(board, "D")).to_have_count(0)
        expect(board.locator("[data-solar-trace]")).to_have_count(3)
        add_candidate(board, "D", result["candidates"][3]["rank"])
        expect(site_picker(board, "D")).to_be_visible()
        expect(board.locator("[data-solar-trace]")).to_have_count(4)
        expect(board.get_by_text("Scroll the table to see all sites", exact=True)).to_be_visible()
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        page.screenshot(path=str(options.output / "mobile.png"), full_page=True)
        # An eligible location outside the ranking can fill a comparison slot.
        board.get_by_role("button", name="Remove Site D", exact=True).click()
        ranked_ids = {site["id"] for site in result["candidates"]}
        mapped_site = next(site for site in result["map_candidates"] if site["id"] not in ranked_ids)
        board.get_by_role("button", name="View sites on 3D Moon", exact=True).click()
        site_map = page.get_by_role("dialog", name="Places to consider · 3D Moon", exact=True)
        site_map.get_by_role("button", name=f"Eligible locations ({len(result['map_candidates'])})", exact=True).click()
        site_map.get_by_role("combobox", name="Select mapped location", exact=True).select_option(mapped_site["id"])
        site_map.get_by_role("button", name="Add mapped site to comparison", exact=True).click()
        expect(site_map.get_by_role("button", name="Remove Site D from comparison", exact=True)).to_be_visible(timeout=135000)
        site_map.get_by_role("button", name="Close site map", exact=True).click()
        expect(comparison.locator(f'[data-metric="{mapped_site["id"]}:earth_visibility_fraction"]')).to_be_visible()
        # The curated replay consumes the actual nested Track A response.
        page.get_by_role("button", name="Choose another area", exact=True).click()
        page.get_by_role("button", name="Browse lunar places", exact=True).click()
        page.get_by_role("button", name="Historic missions", exact=True).click()
        mission = page.locator(".curated-list li").filter(has=page.get_by_text("Apollo 12", exact=True))
        mission.get_by_role("button", name="Open replay", exact=True).click()
        expect(page.locator('[data-metric="apollo-12:sun_elevation_deg"]')).to_have_text("5.1°", timeout=135000)
        assert not errors, errors
        browser.close()
    print(f"Verified site switching, four-site terrain, 10 clock times, {len(values)} UI values, date duplication, mapped-site selection, mobile and replay.")


if __name__ == "__main__":
    main()
