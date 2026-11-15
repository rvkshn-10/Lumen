import io
import struct
from typing import ClassVar

import pytest
from probe_hemisphere_lola import TOTAL_BYTES, fetch_sample, pixel


def test_coordinates_wrap_and_poles_stay_inside_tiles():
    assert pixel(-90, 0) == (0, 23039, 0)
    assert pixel(0, -180) == (180, 0, 0)
    assert pixel(-35, -1) == pixel(-35, 359)
    with pytest.raises(ValueError):
        pixel(1, 0)


def test_reads_little_endian_kilometres_and_checks_range():
    def open_sample(request, **kwargs):
        response = io.BytesIO(struct.pack("<f", -2.5))
        response.status = 206
        bounds = request.get_header("Range").replace("=", " ")
        response.headers = {"Content-Range": f"{bounds}/{TOTAL_BYTES}"}
        return response

    sample = fetch_sample(-35, -1, opener=open_sample)
    assert sample["elevation_m"] == -2500
    assert "180_360" in sample["url"]


def test_refuses_full_download_before_reading():
    class FullResponse(io.BytesIO):
        status = 200
        headers: ClassVar[dict] = {}

        def read(self, *args):
            raise AssertionError("Must reject full response before reading")

    with pytest.raises(ValueError, match="exact requested"):
        fetch_sample(-35, 0, opener=lambda *args, **kwargs: FullResponse())
