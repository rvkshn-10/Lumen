# Lumen V2 Track A — Science & Data

Implements the seven Phase 1 backend deliverables from the November 14, 2026
plan. The existing scientific integration and score definitions are retained.
The `verify-harness` branch supplies the independent oracle and shared fixture;
production code does not import either the oracle or `reference_models.py`.

## Contract additions

Search finalists, fixed-site inspection, comparison and global point previews
return `timeline[].sun_distance_km`, `power`, `events`, `next_sunset`,
`next_earthset`, and `dte`. Search responses include `alternatives` and
`suitability_legend`; every returned map point has `suitability_class`.
The optional TypeScript fields preserve compatibility with legacy responses.

Requests accept:

```json
{
  "dte_margin_deg": 2,
  "power": {
    "area_m2": 1,
    "efficiency": 0.3,
    "load_w": 150,
    "capacity_wh": 2000,
    "start_soc": 1
  },
  "scrub_time_utc": "2028-10-05T12:00:00Z"
}
```

These fields supplement the existing region, time range, hard constraints and
preferences. Scrub time must be within the window. All dates require offsets
and are normalized to UTC before comparison caching.

### Power and contact

The default array is 1 m² at 30% efficiency, vertical and tracking solar azimuth.
Horizontal power is provided for contrast. Both use the reference model:
1361 W/m² × (1 AU / observer-to-Sun distance)² × area × efficiency × incidence
× visible disk fraction. Incidence is clipped cosine of solar elevation for the
vertical array and clipped sine for the horizontal array. Temperature, dust,
degradation, conversion losses and reflected light are excluded.

`power.series` is hourly plus the exact final sample. **Energy and battery
results integrate the full five-minute grid**, including a partial last interval,
using duration-weighted left samples. Battery output matches the independent
bucket model: `depleted_index` is the first depleted integration interval;
negative `min_soc_wh` represents an energy deficit, not physical negative charge.
It is not a thermal, electrical-system or recharge guarantee.

`earth_visible`, its seven legacy window metrics, hard constraints and ranking
remain geometric Earth-center line of sight. `dte_contact` separately requires
Earth's center to be strictly above terrain plus the requested margin. `dte`
contains contact fraction and longest contact/blackout periods. It is not an RF
link budget or DSN station-visibility calculation.

### Events and alternatives

Rise/set events are refined with real ephemerides until their bracket is at most
60 seconds; `uncertainty_minutes` is the half-bracket width (at most 0.5 minutes).
Only transitions bracketed by the five-minute grid are found. Narrow terrain
features and short intervening events may still be missed. The next-set fields
refer to the requested scrub time, or the start. Null means no subsequent event
was found **inside this window**, not that the body will remain visible forever.

Failed fixed-site inspections and empty searches can supply up to three
suggestions. Nearby means the nearest passing prepared point within 5 km,
tested against every original numeric constraint. The shifted-window option
scans ±30 days at daily increments, nearest first, with earlier dates winning
ties. It preserves duration and all constraints. Static terrain failures skip
this futile date scan. Relaxation is offered only when changing one failed
numeric limit exactly to the measured boundary makes all limits pass. Multiple
failed limits are never hidden behind a single relaxation.

Each suggestion includes the effective request, original/changed evidence,
`resolves`, a reason with numbers and a fixed-site `evaluation_endpoint`.
Relaxations explicitly disclose `constraint`, `before`, and `after`. They do
not alter the original request or ranking. For an empty search, `for_site` is
the failed prepared point nearest the circle center (the first deterministic
ID for a full region), rather than a fictitious shortlisted candidate.

## New endpoints

| Endpoint | Contract |
| --- | --- |
| `GET /api/v1/curated-sites` | `{version, sites, provenance}` from the checked-in catalog. |
| `POST /api/v1/compare` | `{sites:[{site_id} or {latitude_deg,longitude_deg_east}], time_range, ...}`; 1–4 distinct locations. |
| `POST /api/v1/historic/{id}/replay` | Optional `{power,dte_margin_deg}`. Returns `touchdown`, `landing_day` (±12 hours), `mission_window` (14 days), and `candidate`. |
| `GET /api/v1/layers/metrics?window=start_utc/end_utc` | Quantized metric columns, stable `site_ids`, scales, offsets and count. URL-encode the query value. |

Comparison preserves input order and uses `rank: null`. It does not discard
failing sites or re-rank them. A coordinate matching an actual prepared point
within one millimeter can receive detailed analysis; other coordinates use the
global coarse terrain. No coordinate is silently snapped. Coarse candidates
have null slope, roughness and score; detailed hard-constraint status is unknown.
All sites share one window and clock. Full-cap search budgets are retained;
fixed-site comparisons can evaluate windows up to 31 days within 2025–2035.

Historic replay alone can use its curated historical landing dates. General
future-mission APIs retain their 2025–2035 limits. Global terrain supports both
hemispheres. Replay uses a **flat zero-degree horizon**, with no invented blocking
ridge coordinates. The terrain display remains coarse NASA LOLA elevation;
replay does not predict local terrain sunsets.

Metric columns are base64-encoded uint8, with 0–254 representing the documented
range and 255 unknown. Decode `offset + value * scale`. Quantization error is at
most half a bin. Five numeric columns for 103,996 cap sites occupy 519,980 bytes
before base64; IDs and JSON add overhead. These display columns must not replace
authoritative scores, hard constraints or raw exports. Classes use fixed score
boundaries 0, 25, 50, 75, 100 (unknown −1), rather than area-local percentiles.

The new calculation endpoints use the existing killable worker and 120-second
watchdog. Checksum-verified disk caches survive worker exit, are keyed by request,
source hashes and implementation hash, and are bounded to 64 MiB. Missing or
damaged optional cache files trigger recomputation. Read-only deployments can
still compute results. Existing terrain and kernel verification remains in force.
Docker includes the curated JSON at the same path as the endpoint.

## Catalog sources

The catalog contains the nine regions named by [NASA in October 2024](https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/),
24 historic landings, 30 existing IAU feature centers and one published connecting
ridge location. It makes no assertion about a current mission's selected landing site.
Artemis coordinates are approximate centers computed from the corner unit vectors
of the [official USGS region polygons](https://www.sciencebase.gov/catalog/item/671a6fa8d34efed5620f89f8).
They are not touchdown points. All curated coordinates initially advertise coarse
analysis; exact prepared grid points are resolved separately during comparison.

Historical coordinates come from [NASA NSSDCA/LROC](https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_artifact_impacts.html),
with per-record landing-time sources and precision. Luna 9's reported position
remains approximate. Connecting Ridge C1 uses [Table 2 of the published study](https://ntrs.nasa.gov/api/citations/20170007365/downloads/20170007365.pdf),
with longitude normalized to −180–180° east. To reproduce the catalog, download
`A3_9regions-lonlat-simplified.zip` from USGS and run:

```powershell
python scripts/data/prepare_curated_sites.py --regions path/to/A3_9regions-lonlat-simplified.zip
```

The output records the downloaded archive and source feature-catalog hashes.

## Verification and handoff

After installing dependencies and preparing the kernels, global terrain and cap:

```powershell
python -m pytest backend/tests
python -m ruff check backend scripts
python scripts/data/export_track_a_evidence.py
python scripts/verify/lumen_verify.py --result data/cache/track-a/cap-analysis.json data/cache/track-a/compare.json data/cache/track-a/failed-site.json data/cache/track-a/replay-apollo-12.json --cache data/cache/track-a/cap-temporal.npz --iterate 5 --report data/cache/track-a/verification
python scripts/verify/lumen_verify.py --self-test --result scripts/verify/fixtures/contract-v2.json --suites ephemeris visibility scoring physics features
```

The producer script imports the app; the checker never does. The original
`reference_models.py` formulas are unchanged. Added checks cover horizontal power,
battery integration, observer distance, DTE, scrub-relative events and disclosed
relaxations. Compare and replay exports are checked without imposing search-only
rank and separation rules. The original mutation self-test is also run in CI.

Verified locally on November 14, 2026: 136 backend/data tests and 48 frontend
tests passed, along with Ruff and the production TypeScript/Vite build. The
five-iteration gate on real full-cap search, four-site comparison, failed-site
suggestions and Apollo replay produced **216 pass, 0 fail, 0 skip**. Worst
Sun/Earth angular difference was 7.73 × 10⁻¹¹ degrees. All **15/15** planted
faults were detected. Reports and real exports are in `data/cache/track-a/`.
Docker packaging was updated; a local Docker image build was not run because
Docker is unavailable in this environment.

Actual Apollo replay output is tested against published touchdown Sun elevations,
including the actual Apollo 16 value of 14.8° from [NASA's HLS study](https://ntrs.nasa.gov/api/citations/20230014980/downloads/HLS-PAP-039%20HLS%20White%20Paper%20Non-Design.pdf).
The older 11.9° entry is a planned value, not the delayed landing's elevation.
Apollo 17 uses the published 13.3° value already used by the supplied verifier.
The pre-1972 oracle correction is detailed in [verification.md](verification.md).

Phase 2 is separate follow-up work: new validated Artemis-region/20 m releases,
optional DSN visibility, and annual illumination-map cross-validation. This
change does not advertise new detailed coverage or manufacture high-resolution terrain.
