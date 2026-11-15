"""Desktop/mobile preparation states, debounce, cancellation and non-blocking submission."""

import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data/cache/preparation-ui"


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((ROOT / "backend/app/data/dataset-manifest.json").read_text(encoding="utf-8"))
    checks = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="chrome", headless=True, args=["--enable-unsafe-swiftshader"])
        for width in (1440, 390):
            page = browser.new_page(viewport={"width": width, "height": 900}, reduced_motion="reduce")
            errors, posted, deleted = [], [], []
            state = {"value": "preparing"}
            page.on("pageerror", lambda error, errors=errors: errors.append(str(error)))
            catalog = {"dataset_version": "qa", "verified": True, "label": "Prepared polar cap",
                       "geometry": {"type": "cap", "extent_m": [-100000, -100000, 100000, 100000], "radius_m": 91000},
                       "excluded_locations": [], "candidate_count": 104000, "candidate_spacing_m": 500,
                       "layers": {"psr_distance": False, "approved_features": True},
                       "public_limits": {"maximum_radius_km": 5, "maximum_live_days": 7,
                                         "full_region_start_utc": "2028-10-01T00:00:00Z", "full_region_end_utc": "2028-10-31T00:00:00Z"},
                       "search_service": {"mode": "synchronous"}, "hemisphere_detailed": True, "hemisphere_survey": True}

            def route_api(route, posted=posted, deleted=deleted, state=state, catalog=catalog):
                path = route.request.url.split("/api/v1")[-1]
                if path.startswith("/search/preparation"):
                    if route.request.method == "POST":
                        posted.append(route.request.post_data_json["region"])
                    if route.request.method == "DELETE":
                        deleted.append(path)
                    route.fulfill(json={"id": f"qa-{len(posted)}", "state": state["value"]})
                elif path == "/coverage":
                    route.fulfill(json=catalog)
                elif path == "/region":
                    route.fulfill(json=manifest)
                elif path == "/coverage/preview":
                    region = route.request.post_data_json
                    route.fulfill(json={"status": "inside", "candidate_count": 827,
                                        "region": region, "dataset_version": "qa", "message": "Verified area"})
                else:
                    route.continue_()

            page.route("**/api/v1/**", route_api)
            page.goto("http://127.0.0.1:8000", wait_until="domcontentloaded", timeout=120000)
            status = page.locator(".preparation-state")
            expect(status).to_contain_text("Preparing search data", timeout=30000)
            scopes = page.get_by_role("group", name="Search scope", exact=True)
            scopes.get_by_role("button", name="Survey the hemisphere", exact=False).click()
            expect(page.get_by_role("button", name="Continue to mission", exact=False)).to_be_enabled()
            state["value"] = "ready"
            expect(status).to_contain_text("Search data ready", timeout=10000)
            scopes.get_by_role("button", name="Search a local area", exact=False).click()
            page.locator(".area-editor > summary").click()
            for latitude in ("-35", "-36", "-37"):
                page.get_by_label("Latitude °S (negative)", exact=True).fill(latitude)
            page.get_by_label("Longitude °E", exact=True).fill("90")
            page.get_by_label("Search radius (km)", exact=True).fill("1")
            expect(status).to_contain_text("Search data ready", timeout=10000)
            locals_ = [region for region in posted if region["selector_type"] != "southern_hemisphere"]
            assert len(locals_) == 1 and locals_[0]["center"]["latitude_deg"] == -37, posted
            assert deleted, "Superseded preparation lease was not canceled"
            state["value"] = "unavailable"
            expect(status).to_contain_text("unavailable", timeout=10000)
            button = page.get_by_role("button", name="Continue to mission", exact=False)
            expect(button).to_be_enabled()
            button.click()
            expect(page.get_by_role("heading", name="Set the mission", exact=True)).to_be_visible()
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1")
            page.screenshot(path=str(OUTPUT / f"mission-{width}.png"), full_page=True)
            assert not errors, errors
            checks.append({"width": width, "states": True, "debounced_latest_area": True,
                           "cancellation": True, "submission_unblocked": True, "page_errors": errors})
            page.close()
        browser.close()
    (OUTPUT / "report.json").write_text(json.dumps(checks, indent=2), encoding="utf-8")
    print(json.dumps(checks, indent=2))


if __name__ == "__main__":
    main()
