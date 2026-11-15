# Southern hemisphere LOLA feasibility

The NASA PDS LOLA LDEM V3.0 256 ppd products cover 0–90 degrees south in
two longitude tiles. Live requests to both tiles succeeded at four southern
locations. The server supports exact HTTP byte ranges, allowing local extraction
without downloading the complete 8,493,465,600-byte southern dataset.

Source directory:
https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/float_img/

The labels specify little-endian float32 elevations in kilometres relative to a
1737.4 km sphere, pixel-centred simple cylindrical registration, east-positive
longitude and the DE421 mean-Earth/polar-axis frame. Spacing is 118.4506 metres
north–south; longitudinal spacing varies with latitude. These are interpolated
gridded heights, not uniform 118 m independent measurements. Labels warn of
possible artifacts at 45-degree latitude-band boundaries.

## Reproduce the access test

```text
python scripts/data/probe_hemisphere_lola.py
```

On Windows environments whose Python CA bundle cannot validate the PDS chain:

```text
pip install truststore
python scripts/data/probe_hemisphere_lola.py --system-trust
```

TLS verification stays enabled. Output is `data/cache/lola-feasibility.json`.
The probe rejects full-body HTTP responses and mismatched ranges, checks finite
elevations and tests both longitude halves. Unit tests cover units, wrapping,
polar array bounds and rejection before reading an unexpected full response.
Four source pixels are an access/encoding check, not terrain validation.

## Required implementation before public detailed search

1. Pin source labels and downloaded terrain windows with checksums and provenance.
   Cache local windows rather than issuing one HTTP request per height sample.
2. Include terrain beyond each 5 km search circle for horizon rays out to 200 km;
   handle longitude seams, equator-crossing rays and polar geometry explicitly.
3. Derive and validate slope and roughness at declared baselines. The existing
   polar products use different metrics; their score anchors cannot simply be
   transferred to DEM-derived hemisphere metrics.
4. Generate 500 m candidate lattices, profiles and stable site IDs, then connect
   search, site inspection, coverage advertising and UI to the new provider.
5. Validate elevations against independent/reference locations, horizon geometry,
   near/far-side visibility, seams and terrain constraints; benchmark cold and
   cached requests before enabling coverage.

LOLA is a viable terrain source for this extension. Hemisphere detailed searches
are not enabled by this feasibility test. The installed coarse preview and polar
detailed search remain the available public modes.

The implementation following this probe is documented in
[Southern hemisphere detailed search](hemisphere-detailed-search.md).
