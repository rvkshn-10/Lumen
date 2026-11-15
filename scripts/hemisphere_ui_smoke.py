"""Desktop/mobile scope-to-refinement UX using recorded science responses."""

import copy
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data/cache/hemisphere-ui"


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    recorded = json.loads((ROOT / "data/cache/hemisphere-survey/search.json").read_text())
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
                    body = copy.deepcopy(recorded)
                    body["request"] = route.request.post_data_json
                else:
                    route.continue_()
                    return
                route.fulfill(json=body)

            page.route("**/api/v1/**", route_api)
            page.goto("http://127.0.0.1:8020", wait_until="domcontentloaded", timeout=120000)
            scope = page.get_by_role("group", name="Search scope", exact=True)
            expect(scope).to_be_visible(timeout=30000)
            scope.get_by_role("button", name="Survey the hemisphere", exact=False).click()
            expect(page.get_by_text("Whole-hemisphere survey ready", exact=True)).to_be_visible()
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
            page.screenshot(path=str(OUTPUT / f"scope-{width}.png"), full_page=True)
            print(f"{width}: advance to mission",flush=True)
            page.get_by_role("button", name="Continue to mission", exact=True).click()
            page.locator(".guide-stage:not([hidden]) details.advanced-mission").first.locator(":scope > summary").click()
            expect(page.locator(".guide-stage:not([hidden]) select[multiple]")).to_be_disabled()
            page.get_by_role("button", name="Review mission", exact=True).click()
            expect(page.locator(".review-facts")).to_contain_text("Whole southern hemisphere")
            assert "Prepared polar cap" not in page.locator(".review-facts").inner_text()
            page.get_by_role("button", name="Find candidate sites", exact=True).click()
            panel = page.get_by_role("region", name="Refine survey results")
            expect(panel).to_be_visible(timeout=30000)
            assert not panel.locator("xpath=ancestor::details").count()
            page.screenshot(path=str(OUTPUT / f"results-{width}.png"), full_page=True)
            print(f"{width}: refine result",flush=True)
            panel.get_by_role("button", name="Refine Candidate 1", exact=False).click()
            expect(scope.get_by_role("button", name="Search a local area", exact=False)).to_have_attribute("aria-pressed", "true")
            print(f"{width}: advance to mission",flush=True)
            page.get_by_role("button", name="Continue to mission", exact=True).click()
            dates = page.locator('.guide-stage:not([hidden]) input[type="datetime-local"]')
            assert dates.nth(0).input_value() == "2028-10-01T00:00"
            assert dates.nth(1).input_value() == "2028-10-08T00:00"
            page.get_by_role("button", name="Back to area", exact=True).click()
            scope.get_by_role("button", name="Survey the hemisphere", exact=False).click()
            scope.get_by_role("button", name="Search a local area", exact=False).click()
            expected_site = recorded["candidates"][0]
            assert abs(float(page.get_by_label("Latitude ° (south is negative)", exact=True).input_value()) - expected_site["latitude_deg"]) < 1e-9
            assert abs(float(page.get_by_label("Longitude °E", exact=True).input_value()) - expected_site["longitude_deg_east"]) < 1e-9
            catalog["hemisphere_survey"] = False
            page.reload(wait_until="domcontentloaded", timeout=120000)
            expect(scope.get_by_role("button", name="Survey the hemisphere", exact=False)).to_be_disabled()
            expect(page.get_by_text("Survey data unavailable on this service", exact=True)).to_be_visible()
            assert not errors, errors
            checks.append({"width": width, "scope_selection": True, "survey_review": True,
                           "visible_refinement": True, "dates_retained": True,
                           "local_selection_retained": True, "unavailable_survey_disabled": True,
                           "page_errors": errors})
            page.close()
            catalog["hemisphere_survey"] = True
        browser.close()
    (OUTPUT / "report.json").write_text(json.dumps(checks, indent=2))
    print(json.dumps(checks, indent=2))


if __name__ == "__main__":
    main()
