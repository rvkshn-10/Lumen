"""Desktop/mobile scope-to-refinement UX using recorded science responses."""

import argparse
import copy
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data/cache/hemisphere-ui"


def inspect_local(page, width, local_result):
    print(f"{width}: inspect local terrain", flush=True)
    page.get_by_label("Latitude °S (negative)", exact=True).fill("-80")
    page.get_by_label("Longitude °E", exact=True).fill("90")
    page.get_by_label("Search radius (km)", exact=True).fill("1")
    page.get_by_role("button", name="Continue to mission", exact=False).click()
    page.locator('.guide-stage:not([hidden]) input[type="datetime-local"]').nth(1).fill("2028-10-02T00:00")
    page.get_by_role("button", name="Review mission", exact=False).click()
    page.get_by_role("button", name="Find candidate sites", exact=True).click()
    expect(page.get_by_role("region", name="Refine survey results")).to_have_count(0, timeout=30000)
    expect(page.get_by_role("heading", name="Compare lunar sites", exact=True)).to_be_visible()
    details = page.locator(".guide-stage:not([hidden]) details.advanced-mission").first
    details.locator(":scope > summary").click()
    details.get_by_role("button", name="Inspect site 01", exact=True).click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_contain_text("500 m central-difference baseline")
    dialog.get_by_role("tab", name="Terrain & sky", exact=True).click()
    resolution = local_result["terrain_data"]["resolution_m"]
    expect(dialog).to_contain_text(f"Display sampling: {resolution:g} m")
    dialog.locator("select").first.select_option("map")
    expect(dialog.get_by_role("img", name="Top-down terrain map with candidate locations", exact=True)).to_be_visible(timeout=60000)
    page.screenshot(path=str(OUTPUT / f"detail-{width}.png"), full_page=True)
    dialog.get_by_role("button", name="Close panel", exact=True).click()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local-only", action="store_true", help="Verify the detailed terrain result view without repeating survey checks")
    options = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    recorded = json.loads((ROOT / "data/cache/hemisphere-survey/search.json").read_text())
    local_result = json.loads((ROOT / "data/cache/hemisphere-detailed/search--80-90.json").read_text(encoding="utf-8"))
    manifest = json.loads((ROOT / "backend/app/data/dataset-manifest.json").read_text())
    catalog = {"dataset_version": "qa", "verified": True, "label": "Prepared polar cap",
               "geometry": {"type": "cap", "extent_m": [-100000, -100000, 100000, 100000], "radius_m": 91000},
               "excluded_locations": [], "candidate_count": 104000, "candidate_spacing_m": 500,
               "layers": {"psr_distance": False, "approved_features": True},
               "public_limits": {"maximum_radius_km": 5, "maximum_live_days": 7,
                                 "full_region_start_utc": "2028-10-01T00:00:00Z", "full_region_end_utc": "2028-10-31T00:00:00Z"},
               "search_service": {"mode": "synchronous"}, "hemisphere_detailed": True, "hemisphere_survey": True}
    checks = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        for width in (1440, 390):
            print(f"{width}: load revamped UI and Moon", flush=True)
            page = browser.new_page(viewport={"width": width, "height": 900}, reduced_motion="reduce")
            errors = []
            page.on("pageerror", lambda error, errors=errors: errors.append(error.stack or str(error)))

            def route_api(route):
                path = route.request.url.split("/api/v1")[-1]
                if path == "/coverage":
                    body = catalog
                elif path == "/region":
                    body = manifest
                elif path == "/coverage/preview":
                    region = route.request.post_data_json
                    survey = region["selector_type"] == "southern_hemisphere"
                    body = {"status": "inside", "candidate_count": 827 if survey else 317,
                            "region": region, "dataset_version": "qa",
                            "message": "Whole southern hemisphere survey; approximately 150 km spacing." if survey else "Detailed local terrain available."}
                elif path == "/candidates/search":
                    body = copy.deepcopy(recorded if route.request.post_data_json["region"]["selector_type"] == "southern_hemisphere" else local_result)
                    body["request"] = route.request.post_data_json
                else:
                    route.continue_()
                    return
                route.fulfill(json=body)

            page.route("**/api/v1/**", route_api)
            page.goto("http://127.0.0.1:8000", wait_until="domcontentloaded", timeout=120000)
            scope = page.get_by_role("group", name="Search scope", exact=True)
            expect(scope).to_be_visible(timeout=30000)
            if options.local_only:
                page.locator(".area-editor > summary").click()
                inspect_local(page, width, local_result)
                assert not errors, errors
                checks.append({"width": width, "local_terrain_mesh": True, "page_errors": errors})
                page.close()
                continue
            expect(page.locator(".planner-masthead")).to_be_visible()
            expect(page.get_by_role("heading", name="Choose an area", exact=True)).to_be_visible()
            scope.get_by_role("button", name="Survey the hemisphere", exact=False).click()
            expect(page.locator(".area-coverage-status")).to_contain_text("827 regional survey locations")
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
            assert scope.get_by_role("button").first.bounding_box()["width"] >= min(width - 60, 240)
            expect(page.get_by_role("button", name="Go to my site", exact=True)).to_be_visible(timeout=60000)
            expect(page.locator(".scene-loading")).to_have_count(0, timeout=120000)
            page.get_by_role("button", name="Help & settings", exact=True).click()
            page.get_by_role("dialog", name="Help & settings").get_by_role("combobox").first.select_option("dark")
            expect(page.locator("html")).to_have_attribute("data-appearance", "dark")
            page.get_by_role("dialog", name="Help & settings").get_by_role("combobox").first.select_option("light")
            expect(page.locator("html")).to_have_attribute("data-appearance", "light")
            page.get_by_role("button", name="Close panel", exact=True).click()
            page.screenshot(path=str(OUTPUT / f"scope-{width}.png"), full_page=True)
            print(f"{width}: advance to mission",flush=True)
            page.get_by_role("button", name="Continue to mission", exact=False).click()
            page.locator(".guide-stage:not([hidden]) details.advanced-mission").first.locator(":scope > summary").click()
            page.locator(".guide-stage:not([hidden]) details.advanced-mission details.advanced-mission > summary").click()
            expect(page.locator(".guide-stage:not([hidden]) select[multiple]")).to_be_disabled()
            page.get_by_role("button", name="Review mission", exact=False).click()
            expect(page.locator(".review-facts")).to_contain_text("Whole southern hemisphere")
            assert "Prepared polar cap" not in page.locator(".review-facts").inner_text()
            page.get_by_role("button", name="Find candidate sites", exact=True).click()
            panel = page.get_by_role("region", name="Refine survey results")
            expect(panel).to_be_visible(timeout=30000)
            assert not panel.locator("xpath=ancestor::details").count()
            expect(page.get_by_role("heading", name="Estimated solar generation", exact=True)).to_be_visible()
            page.screenshot(path=str(OUTPUT / f"results-{width}.png"), full_page=True)
            page.emulate_media(media="print")
            expect(page.locator(".scenario-board").first).to_be_visible()
            page.emulate_media(media="screen")
            print(f"{width}: refine result",flush=True)
            panel.get_by_role("button", name="Refine Candidate 1", exact=False).click()
            expect(scope.get_by_role("button", name="Search a local area", exact=False)).to_have_attribute("aria-pressed", "true")
            print(f"{width}: advance to mission",flush=True)
            page.get_by_role("button", name="Continue to mission", exact=False).click()
            dates = page.locator('.guide-stage:not([hidden]) input[type="datetime-local"]')
            assert dates.nth(0).input_value() == "2028-10-01T00:00"
            assert dates.nth(1).input_value() == "2028-10-08T00:00"
            page.get_by_role("button", name="Back to area", exact=True).click()
            scope.get_by_role("button", name="Survey the hemisphere", exact=False).click()
            scope.get_by_role("button", name="Search a local area", exact=False).click()
            page.locator(".area-editor > summary").click()
            expected_site = recorded["candidates"][0]
            assert abs(float(page.get_by_label("Latitude °S (negative)", exact=True).input_value()) - expected_site["latitude_deg"]) < 1e-9
            assert abs(float(page.get_by_label("Longitude °E", exact=True).input_value()) - expected_site["longitude_deg_east"]) < 1e-9
            inspect_local(page, width, local_result)
            page.get_by_role("navigation", name="Planning stages").get_by_role("button", name="Area", exact=True).click()
            catalog["hemisphere_survey"] = False
            page.reload(wait_until="domcontentloaded", timeout=120000)
            expect(scope.get_by_role("button", name="Survey the hemisphere", exact=False)).to_be_disabled()
            expect(page.get_by_text("Survey data unavailable on this service", exact=True)).to_be_visible()
            page.get_by_role("button", name="Open the demo comparison", exact=False).click()
            expect(page.locator(".compare-page")).to_be_visible(timeout=30000)
            page.get_by_role("navigation", name="Planning stages").get_by_role("button", name="Area", exact=True).click()
            expect(scope).to_be_visible()
            assert not errors, errors
            checks.append({"width": width, "github_masthead": True, "appearance": True, "solar_generation": True, "print_comparison": True, "local_terrain_mesh": True, "demo_navigation": True, "scope_selection": True, "survey_review": True,
                           "visible_refinement": True, "dates_retained": True,
                           "local_selection_retained": True, "unavailable_survey_disabled": True,
                           "page_errors": errors})
            page.close()
            catalog["hemisphere_survey"] = True
        browser.close()
    (OUTPUT / ("local-terrain-report.json" if options.local_only else "report.json")).write_text(json.dumps(checks, indent=2))
    print(json.dumps(checks, indent=2))


if __name__ == "__main__":
    main()
