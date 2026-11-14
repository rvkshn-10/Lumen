"""Independent (SPICE-free) lunar-surface Sun/Earth geometry oracle.

Reads JPL DAF SPK/PCK Chebyshev segments directly with numpy, applies
converged light time + stellar aberration, and reproduces Lumen's local
az/el without calling CSPICE. Used to cross-check the app's ephemeris path.
"""
from __future__ import annotations

import re
import struct
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

C_KMS = 299792.458
AS2R = np.pi / 180 / 3600


class DAF:
    def __init__(self, path):
        self.f = Path(path).read_bytes()
        nd, ni = struct.unpack("<ii", self.f[8:16])
        self.nd, self.ni = nd, ni
        fward = struct.unpack("<i", self.f[76:80])[0]
        ss = nd + (ni + 1) // 2
        self.segments = []
        rec = fward
        while rec:
            base = (rec - 1) * 1024
            nxt, _prv, nsum = struct.unpack("<3d", self.f[base:base + 24])
            for i in range(int(nsum)):
                off = base + 24 + i * ss * 8
                dc = struct.unpack(f"<{nd}d", self.f[off:off + nd * 8])
                ic = struct.unpack(f"<{ni}i", self.f[off + nd * 8: off + nd * 8 + ni * 4])
                self.segments.append((dc, ic))
            rec = int(nxt)

    def doubles(self, start, end):  # 1-based inclusive word addresses
        return np.frombuffer(self.f[(start - 1) * 8:end * 8], dtype="<f8")


class Cheb:
    """Type-2 Chebyshev segment (position or Euler angles), 3 components."""
    def __init__(self, daf, start, end):
        init, intlen, rsize, n = daf.doubles(end - 3, end)
        self.init, self.intlen, self.rsize, self.n = init, intlen, int(rsize), int(n)
        self.data = daf.doubles(start, start + self.rsize * self.n - 1).reshape(self.n, self.rsize)
        self.deg = (self.rsize - 2) // 3

    def __call__(self, et):
        et = np.atleast_1d(np.asarray(et, float))
        idx = np.clip(((et - self.init) // self.intlen).astype(int), 0, self.n - 1)
        rec = self.data[idx]
        mid, rad = rec[:, 0], rec[:, 1]
        s = (et - mid) / rad
        k = self.deg
        T = np.empty((k, len(et))); dT = np.empty((k, len(et)))
        T[0], dT[0] = 1, 0
        if k > 1: T[1], dT[1] = s, 1
        for j in range(2, k):
            T[j] = 2 * s * T[j - 1] - T[j - 2]
            dT[j] = 2 * T[j - 1] + 2 * s * dT[j - 1] - dT[j - 2]
        coef = rec[:, 2:].reshape(len(et), 3, k)
        pos = np.einsum("nck,kn->nc", coef, T)
        vel = np.einsum("nck,kn->nc", coef, dT) / rad[:, None]
        return pos, vel


class Ephemeris:
    def __init__(self, kernel_dir: Path):
        kd = Path(kernel_dir)
        spk = DAF(kd / "de440s.bsp")
        self.spk = {}
        for (a, b), (tgt, ctr, frame, typ, s, e) in spk.segments:
            if typ == 2:
                self.spk[(tgt, ctr)] = Cheb(spk, s, e)
        pck = DAF(kd / "moon_pa_de440_200625.bpc")
        segs = [(dc, ic) for dc, ic in pck.segments if ic[2] == 2]  # type 2
        segs.sort(key=lambda x: x[0][0])
        self.pck = [(dc[0], dc[1], Cheb(pck, ic[3], ic[4])) for dc, ic in segs]
        self.pck_ref = segs[0][1][1]
        self.delta_at = self._leaps(kd / "naif0012.tls")
        a1, a2, a3 = np.array([67.8526, 78.6944, 0.2785]) * AS2R
        # TKFRAME ANGLES (3,2,1): matrix maps MOON_ME -> MOON_PA, so PA -> ME is its transpose.
        # Verified against CSPICE output to ~1e-12 deg (see lumen_verify.py ephemeris suite).
        self.pa2me = (rot(3, a1) @ rot(2, a2) @ rot(1, a3)).T

    @staticmethod
    def _leaps(path):
        txt = path.read_text()
        block = re.search(r"DELTET/DELTA_AT\s*=\s*\((.*?)\)", txt, re.DOTALL).group(1)
        pairs = re.findall(r"(\d+),\s*@(\d{4})-([A-Z]{3})-(\d+)", block)
        mon = {"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
               "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12}
        return [(datetime(int(y), mon[m], int(d), tzinfo=UTC), int(n)) for n, y, m, d in pairs]

    def utc_to_et(self, t: datetime):
        if t.tzinfo is None:
            raise ValueError("Oracle UTC dates require an explicit offset")
        t = t.astimezone(UTC)
        # Match NAIF's documented uniform-day pre-1972 UTC convention, not a
        # reconstruction of historical fractional UTC. Before its first LSK
        # entry SPICE uses one second less than that entry (9 s for naif0012).
        # The former 10 s fallback shifted all historic oracle samples by 1 s.
        dat = max((n for d, n in self.delta_at if d <= t), default=self.delta_at[0][1] - 1)
        j2000 = datetime(2000, 1, 1, 12, tzinfo=UTC)
        tai_like = (t - j2000).total_seconds() + dat + 32.184
        # periodic TDB-TT term (naif0012 K, EB, M)
        M = 6.239996 + 1.99096871e-7 * tai_like
        E = M + 1.671e-2 * np.sin(M)
        return tai_like + 1.657e-3 * np.sin(E)

    def state_ssb(self, body, et):
        chain = {10: [(10, 0)], 399: [(399, 3), (3, 0)], 301: [(301, 3), (3, 0)]}[body]
        p = 0; v = 0
        for key in chain:
            pp, vv = self.spk[key](et)
            p = p + pp; v = v + vv
        return p, v

    def moon_pa(self, et):
        et = np.atleast_1d(et)
        out = np.empty((len(et), 3, 3))
        for i, t in enumerate(et):
            for a, b, ch in self.pck:
                if a <= t <= b:
                    phi, delta, w = ch(t)[0][0]
                    out[i] = rot(3, w) @ rot(1, delta) @ rot(3, phi)
                    break
            else:
                raise ValueError("PCK coverage")
        return out  # J2000 -> PA

    def apparent(self, target, et, transmit=False):
        """Moon-centred apparent target vector in MOON_ME (km). CN+S / XCN+S."""
        et = np.atleast_1d(np.asarray(et, float))
        po, vo = self.state_ssb(301, et)
        sign = 1 if transmit else -1
        lt = np.zeros(len(et))
        for _ in range(6):
            pt, _ = self.state_ssb(target, et + sign * lt)
            lt = np.linalg.norm(pt - po, axis=1) / C_KMS
        r = pt - po
        r = stellar(r, vo, transmit)
        R = np.einsum("ij,njk->nik", self.pa2me, self.moon_pa(et))
        return np.einsum("nij,nj->ni", R, r)


def stellar(r, v, transmit):
    u = r / np.linalg.norm(r, axis=1)[:, None]
    vc = (-v if transmit else v) / C_KMS
    h = np.cross(u, vc)
    s = np.linalg.norm(h, axis=1)
    phi = np.arcsin(np.clip(s, -1, 1))
    axis = h / np.where(s > 0, s, 1)[:, None]
    # rotate r about axis by phi (Rodrigues)
    c, sn = np.cos(phi)[:, None], np.sin(phi)[:, None]
    return r * c + np.cross(axis, r) * sn + axis * np.sum(axis * r, axis=1)[:, None] * (1 - c)


def rot(axis, a):
    c, s = np.cos(a), np.sin(a)
    if axis == 1: return np.array([[1, 0, 0], [0, c, s], [0, -s, c]])
    if axis == 2: return np.array([[c, 0, -s], [0, 1, 0], [s, 0, c]])
    return np.array([[c, s, 0], [-s, c, 0], [0, 0, 1]])


RADIUS_M = 1_737_400.0
SUN_RADIUS_KM = 695_700.0


def local_sky(lat_deg, lon_deg, elevation_m, body_km, observer_height_m=2.0):
    lat, lon = np.deg2rad([lat_deg, lon_deg])
    up = np.array([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)])
    east = np.array([-np.sin(lon), np.cos(lon), 0])
    north = np.cross(up, east)
    v = body_km - up * ((RADIUS_M + elevation_m + observer_height_m) / 1000)
    d = np.linalg.norm(v, axis=1)
    az = np.rad2deg(np.arctan2(v @ east, v @ north)) % 360
    el = np.rad2deg(np.arcsin(np.clip(v @ up / d, -1, 1)))
    return az, el, d
