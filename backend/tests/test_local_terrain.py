import math

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import local_terrain

pytestmark = pytest.mark.skipif(not local_terrain.DEM.exists(), reason="NASA LOLA 80 m DEM not installed")


def test_local_window_is_dense_and_hole_free():
    terrain = local_terrain.local_terrain(0, 15000, 6)
    assert terrain["width"] == terrain["height"] >= 100
    assert terrain["source_resolution_m"] == 80
    assert terrain["resolution_m"] <= 120
    assert len(terrain["elevations_m"]) == terrain["width"] * terrain["height"]
    assert all(value is not None and math.isfinite(value) for value in terrain["elevations_m"])
    left, bottom, right, top = terrain["extent_m"]
    assert left < 0 < right and bottom < 15000 < top


def test_endpoint_clamps_and_reports_source():
    response = TestClient(app).get("/api/v1/terrain/local", params={"x_m": 0, "y_m": 15000, "half_km": 500})
    assert response.status_code == 200
    body = response.json()
    assert body["source"].startswith("NASA PGDA LOLA")
    assert body["width"] <= local_terrain.MAX_SIDE
