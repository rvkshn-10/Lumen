import { useEffect, useMemo, useRef } from "react";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { Canvas } from "@react-three/fiber";
import { Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type {
  Candidate,
  TerrainData,
  MapCandidate,
  MapLayer,
  PSRLayer,
  LunarFeature,
  TimeSample,
} from "../lib/types";
import { SceneBoundary } from "./SceneBoundary";
import { SceneLabel } from "./SceneLabel";
import { compareSiteLabel, compareSiteLetter } from "../lib/compare-sites";
import {
  BLOCKED_COLOR, BODY_COLORS, COMPARE_COLORS, SUITABILITY_COLORS, SUITABILITY_LABELS,
  blockerAt, groundDirection, horizonAt, sampleIndexAt, suitabilityClass, type Body,
} from "../lib/sky-geometry";
import { dumpRow, registerSceneDump } from "../lib/scene-parity";

/** Terrain heights are drawn 1.5× so relief reads; sight lines and the Sun use the same factor. */
const HEIGHT_SCALE = 1.5;

interface LayerOptions {
  previewPoint?: boolean;
  onPick?: (x_m: number, y_m: number) => void;
  studyArea?: { x_m: number; y_m: number; radius_m: number };
  /** Current scene time: lights the terrain from the real Sun and drives sight lines and pin status. */
  sample?: TimeSample;
  /** Up to four candidate ids drawn in the compare colours (Okabe–Ito). */
  compare?: string[];
  /** Keep the shared view framed on the comparison even as the active sites change with time. */
  comparisonSites?: Candidate[];
  layer: MapLayer;
  mapCandidates: MapCandidate[];
  psr: PSRLayer | null;
  features: LunarFeature[];
}
function pointColor(point: MapCandidate, layer: MapLayer) {
  if (layer === "suitability") {
    const cls = point.suitability_class ?? suitabilityClass(point.score);
    return new THREE.Color(cls === -1 ? "#3a3f3e" : SUITABILITY_COLORS[cls]);
  }
  const value =
    layer === "illumination"
      ? point.illumination_fraction
      : layer === "earth_visibility"
        ? point.earth_visibility_fraction
        : point.score / 100;
  return new THREE.Color(
    layer === "illumination"
      ? "#48402d"
      : layer === "earth_visibility"
        ? "#2e4253"
        : "#655071",
  ).lerp(
    new THREE.Color(
      layer === "illumination"
        ? "#f2d583"
        : layer === "earth_visibility"
          ? "#acd9ed"
          : "#c3e6aa",
    ),
    Math.max(0, Math.min(1, value)),
  );
}
function psrAt(psr: PSRLayer | null, x: number, y: number) {
  if (!psr) return 0;
  const [xmin, ymin, xmax, ymax] = psr.extent_m;
  const col = Math.min(
    psr.width - 1,
    Math.max(0, Math.floor(((x - xmin) / (xmax - xmin)) * psr.width)),
  );
  const row = Math.min(
    psr.height - 1,
    Math.max(0, Math.floor(((ymax - y) / (ymax - ymin)) * psr.height)),
  );
  return psr.psr_fraction[row * psr.width + col] ?? 0;
}
function featurePoint(feature: LunarFeature) {
  const rho =
    2 *
    1737400 *
    Math.tan(Math.PI / 4 + (feature.latitude_deg * Math.PI) / 360);
  const lon = (feature.longitude_deg_east * Math.PI) / 180;
  return [rho * Math.sin(lon), rho * Math.cos(lon)];
}
function CandidateCloud({
  terrain,
  points,
  layer,
  selected,
  onSelect,
}: {
  terrain: TerrainData;
  points: MapCandidate[];
  layer: MapLayer;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const geometry = useMemo(() => {
    const base = baseHeight(terrain);
    const positions = new Float32Array(points.length * 3),
      colors = new Float32Array(points.length * 3);
    points.forEach((point, i) => {
      positions.set(
        [
          point.x_m / 1000,
          ((heightAt(terrain, point.x_m, point.y_m) - base) / 1000) * 1.5 +
            0.055,
          -point.y_m / 1000,
        ],
        i * 3,
      );
      const color =
        point.id === selected
          ? new THREE.Color("#ffffff")
          : pointColor(point, layer);
      colors.set([color.r, color.g, color.b], i * 3);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return geo;
  }, [terrain, points, layer, selected]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <points
      geometry={geometry}
      frustumCulled={false}
      onClick={(event) => {
        event.stopPropagation();
        const point = points[event.index ?? -1];
        if (point) onSelect(point.id);
      }}
    >
      <pointsMaterial
        size={0.17}
        vertexColors
        sizeAttenuation
        transparent
        opacity={0.95}
        depthWrite={false}
      />
    </points>
  );
}

/** Bilinear height, matching how the mesh triangles interpolate, so pins and lines sit on the ground. */
function heightAt(terrain: TerrainData, x: number, y: number) {
  const [xmin, ymin, xmax, ymax] = terrain.extent_m;
  const fx = Math.max(0, Math.min(terrain.width - 1, ((x - xmin) / (xmax - xmin)) * (terrain.width - 1)));
  const fy = Math.max(0, Math.min(terrain.height - 1, ((ymax - y) / (ymax - ymin)) * (terrain.height - 1)));
  const c0 = Math.floor(fx), r0 = Math.floor(fy);
  const c1 = Math.min(terrain.width - 1, c0 + 1), r1 = Math.min(terrain.height - 1, r0 + 1);
  const tx = fx - c0, ty = fy - r0;
  const at = (row: number, col: number) => terrain.elevations_m[row * terrain.width + col];
  const corners = [at(r0, c0), at(r0, c1), at(r1, c0), at(r1, c1)];
  if (corners.some(value => value == null)) return corners.find(value => value != null) ?? 0;
  const [a, b, c, d] = corners as number[];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

function terrainMinimum(terrain: TerrainData) {
  let minimum = Infinity;
  for (const value of terrain.elevations_m) if (value != null && value < minimum) minimum = value;
  return Number.isFinite(minimum) ? minimum : 0;
}
const minimumCache = new WeakMap<TerrainData, number>();
function baseHeight(terrain: TerrainData) {
  let value = minimumCache.get(terrain);
  if (value == null) { value = terrainMinimum(terrain); minimumCache.set(terrain, value); }
  return value;
}

function insideTerrain(terrain: TerrainData, x: number, y: number) {
  const [xmin, ymin, xmax, ymax] = terrain.extent_m;
  return x >= xmin && x <= xmax && y >= ymin && y <= ymax;
}

/** Scene-space direction (x east-ish, y up, z = −projected y) toward a body, with the terrain's height scale. */
function sceneDirection(longitudeDeg: number, azimuthDeg: number, elevationDeg: number, crs?: string) {
  const [gx, gy] = groundDirection(longitudeDeg, azimuthDeg, crs);
  const up = Math.tan((Math.max(-80, Math.min(80, elevationDeg)) * Math.PI) / 180) * HEIGHT_SCALE;
  return new THREE.Vector3(gx, up, -gy).normalize();
}

/** Light the terrain from where the Sun really is at this time, with cast shadows. */
function SunLight({ terrain, sample, longitudeDeg, frame }: { terrain: TerrainData; sample: TimeSample; longitudeDeg: number; frame?: { x: number; z: number; spanKm: number } }) {
  const [xmin, ymin, xmax, ymax] = terrain.extent_m;
  const cx = frame?.x ?? (xmin + xmax) / 2000, cz = frame?.z ?? -(ymin + ymax) / 2000;
  // Fit the shadow camera to what is on screen, not the whole map: sharper shadows, less work per frame.
  const half = (frame?.spanKm ?? Math.max(xmax - xmin, ymax - ymin) / 1000) / 2 * 1.25;
  // Keep the light a hair above the ground plane so a grazing Sun still shades slopes.
  const dir = sceneDirection(longitudeDeg, sample.sun_azimuth_deg, Math.max(.4, sample.sun_elevation_deg), terrain.crs);
  const position = new THREE.Vector3(cx, 0, cz).add(dir.clone().multiplyScalar(half * 2));
  const target = useMemo(() => new THREE.Object3D(), []);
  target.position.set(cx, 0, cz);
  const up = sample.sun_elevation_deg > -1;
  return <>
    <primitive object={target} />
    <directionalLight castShadow position={position} target={target} intensity={up ? 2.6 : .35} color="#fff4dc"
      shadow-mapSize-width={1024} shadow-mapSize-height={1024} shadow-bias={-0.0005} shadow-normalBias={0.03}
      shadow-camera-left={-half} shadow-camera-right={half} shadow-camera-top={half} shadow-camera-bottom={-half}
      shadow-camera-near={0.05} shadow-camera-far={half * 5} />
  </>;
}

/** Point the camera at the focus once per focus change, so orbiting is never yanked back. */
function Controls({ target, minDistance, maxDistance }: { target: [number, number, number]; minDistance: number; maxDistance: number }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const key = target.map(value => value.toFixed(3)).join(",");
  useEffect(() => {
    controls.current?.target.set(...target);
    controls.current?.update();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return <OrbitControls ref={controls} makeDefault enableDamping={false} minDistance={minDistance} maxDistance={maxDistance} maxPolarAngle={Math.PI / 2.05} />;
}

/**
 * Lines from a site toward the Sun and Earth. In view: a solid line in the
 * body's colour. Blocked: a dashed grey line that stops on the ridge that
 * blocks it (the sampled blocker from the horizon profile), with a marker.
 */
function SightLines({ terrain, site, sample, base, markerSize }: { terrain: TerrainData; site: Candidate; sample: TimeSample; base: number; markerSize?: number }) {
  const [xmin, ymin, xmax, ymax] = terrain.extent_m;
  const spanKm = Math.max(xmax - xmin, ymax - ymin) / 1000;
  const m = markerScale(terrain, markerSize);
  const origin = new THREE.Vector3(site.x_m / 1000, ((heightAt(terrain, site.x_m, site.y_m) - base) / 1000) * HEIGHT_SCALE + .14, -site.y_m / 1000);
  const profile = site.horizon.map(h => h.elevation_deg);
  const lines = (["sun", "earth"] as const).map(body => {
    const az = body === "sun" ? sample.sun_azimuth_deg : sample.earth_azimuth_deg;
    const el = body === "sun" ? sample.sun_elevation_deg : sample.earth_elevation_deg;
    const visible = body === "sun" ? sample.sun_visible : sample.earth_visible;
    const dir = sceneDirection(site.longitude_deg_east, az, el, terrain.crs);
    if (visible) return { body, visible, points: [origin, origin.clone().add(dir.multiplyScalar(spanKm * .32))], blocker: null as THREE.Vector3 | null, far: false };
    const ray = blockerAt(site.horizon, az);
    const distance = ray?.distance_m ?? spanKm * 300;
    const [gx, gy] = groundDirection(site.longitude_deg_east, az, terrain.crs);
    const bx = site.x_m + gx * distance, by = site.y_m + gy * distance;
    const inside = bx >= xmin && bx <= xmax && by >= ymin && by <= ymax;
    if (!inside) {
      const end = origin.clone().add(dir.multiplyScalar(spanKm * .32));
      return { body, visible, points: [origin, end], blocker: null, far: true, distance };
    }
    const blocker = new THREE.Vector3(bx / 1000, ((heightAt(terrain, bx, by) - base) / 1000) * HEIGHT_SCALE + .08, -by / 1000);
    return { body, visible, points: [origin, blocker], blocker, far: false, distance };
  });
  useEffect(() => registerSceneDump(`terrain-sight:${site.id}`, () => [dumpRow("terrain-sight", site.id, sample, {
    sunHorizon: horizonAt(profile, sample.sun_azimuth_deg), earthHorizon: horizonAt(profile, sample.earth_azimuth_deg),
    sunVisible: lines[0].visible, earthVisible: lines[1].visible,
  })]));
  return <>{lines.map(line => <group key={line.body}>
    <Line points={line.points} color={line.visible ? BODY_COLORS[line.body as Body] : BLOCKED_COLOR}
      lineWidth={line.visible ? 3 : 2} dashed={!line.visible} dashSize={.35} gapSize={.25} />
    {line.visible && <SceneLabel text={line.body === "sun" ? "To the Sun" : "To Earth"} color={BODY_COLORS[line.body as Body]}
      position={line.points[1].clone().add(new THREE.Vector3(0, .5 * m, 0)).toArray() as [number, number, number]} width={2.2 * m} />}
    {line.blocker && <>
      <mesh position={line.blocker}><octahedronGeometry args={[.22 * m]} /><meshBasicMaterial color={BODY_COLORS[line.body as Body]} /></mesh>
      <SceneLabel text={`Ridge hides ${line.body === "sun" ? "Sun" : "Earth"}`} color="#e8ece9"
        position={line.blocker.clone().add(new THREE.Vector3(0, .7 * m, 0)).toArray() as [number, number, number]} width={3.4 * m} />
    </>}
    {line.far && <SceneLabel text={`${line.body === "sun" ? "Sun" : "Earth"} hidden by terrain ${((line.distance ?? 0) / 1000).toFixed(0)} km away`} color="#e8ece9"
      position={line.points[1].clone().add(new THREE.Vector3(0, .5 * m, 0)).toArray() as [number, number, number]} width={5.2 * m} />}
  </group>)}</>;
}

/** Pins and labels are sized for a ~40 km patch; the full cap is 200 km, so grow them with the extent. */
function markerScale(terrain: TerrainData, override?: number) {
  if (override) return override;
  const spanKm = Math.max(terrain.extent_m[2] - terrain.extent_m[0], terrain.extent_m[3] - terrain.extent_m[1]) / 1000;
  return Math.max(.25, spanKm / 40);
}

/** Two small dots over a pin: Sun and Earth, lit when in view at the current time. */
function StatusDots({ site, sample }: { site: Candidate; sample: TimeSample }) {
  const own = site.timeline[sampleIndexAt(site.timeline, sample.time_utc)];
  useEffect(() => registerSceneDump(`terrain-pin:${site.id}`, () => own ? [dumpRow("terrain-pin", site.id, own, {
    sunHorizon: horizonAt(site.horizon.map(row => row.elevation_deg), own.sun_azimuth_deg),
    earthHorizon: horizonAt(site.horizon.map(row => row.elevation_deg), own.earth_azimuth_deg),
    sunVisible: own.sun_visible, earthVisible: own.earth_visible,
  })] : []), [site, own]);
  if (!own) return null;
  return <>{(["sun", "earth"] as const).map((body, i) => {
    const on = body === "sun" ? own.sun_visible : own.earth_visible;
    return <mesh key={body} position={[i ? .17 : -.17, 1.15, 0]}>
      <sphereGeometry args={[.11, 16, 12]} />
      <meshBasicMaterial color={on ? BODY_COLORS[body] : "#3b4442"} />
    </mesh>;
  })}</>;
}

function SuitabilityLegend() {
  return <div className="suitability-legend" aria-label="Suitability colour key">
    <strong>Suitability for your priorities</strong>
    <div>{SUITABILITY_LABELS.map((label, i) => <span key={label}><i style={{ background: SUITABILITY_COLORS[i] }} />{label}</span>)}</div>
    <small>From the planning score: 0–25 poor · 25–50 fair · 50–75 good · 75–100 excellent</small>
  </div>;
}

function TerrainMesh({
  terrain,
  candidates,
  selected,
  onSelect,
  layer,
  mapCandidates,
  psr,
  features,
  previewPoint,
  studyArea,
  onPick,
  sample,
  compare = [],
  markerSize,
}: {
  terrain: TerrainData;
  candidates: Candidate[];
  selected: string | null;
  onSelect: (id: string) => void;
  markerSize?: number;
} & LayerOptions) {
  const elevation = layer === "elevation";
  const { geometry, base } = useMemo(() => {
    const {
      width,
      height,
      elevations_m,
      extent_m: [xmin, ymin, xmax, ymax],
    } = terrain;
    const values = elevations_m.filter(
      (x): x is number => x != null && Number.isFinite(x),
    );
    let minimum = Infinity, maximum = -Infinity;
    for (const value of values) { if (value < minimum) minimum = value; if (value > maximum) maximum = value; }
    const positions = new Float32Array(width * height * 3);
    const colors = new Float32Array(width * height * 3);
    const indices: number[] = [];
    const low = new THREE.Color(elevation ? "#1b3b38" : "#343434"),
      high = new THREE.Color(elevation ? "#a7d8a6" : "#c0c0c0");
    for (let row = 0; row < height; row++)
      for (let col = 0; col < width; col++) {
        const i = row * width + col,
          h = elevations_m[i] ?? minimum;
        positions.set(
          [
            (xmin + (col / (width - 1)) * (xmax - xmin)) / 1000,
            ((h - minimum) / 1000) * 1.5,
            -(ymax - (row / (height - 1)) * (ymax - ymin)) / 1000,
          ],
          i * 3,
        );
        const color = low
          .clone()
          .lerp(high, (h - minimum) / Math.max(1, maximum - minimum));
        if (layer === "psr") {
          const x = xmin + (col / (width - 1)) * (xmax - xmin),
            y = ymax - (row / (height - 1)) * (ymax - ymin);
          color.lerp(new THREE.Color("#a09ace"), psrAt(psr, x, y) * 0.9);
        }
        colors.set([color.r, color.g, color.b], i * 3);
        if (
          row < height - 1 &&
          col < width - 1 &&
          [i, i + 1, i + width, i + width + 1].every(
            (j) => elevations_m[j] != null,
          )
        )
          indices.push(i, i + width, i + 1, i + 1, i + width, i + width + 1);
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return { geometry: geo, base: minimum };
  }, [terrain, elevation, layer, psr]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <group>
      <mesh geometry={geometry} castShadow={!!sample} receiveShadow={!!sample} onClick={event => {
        if (!onPick || event.delta > 5 || event.button !== 0) return;
        event.stopPropagation();
        onPick(event.point.x * 1000, -event.point.z * 1000);
      }}>
        <meshStandardMaterial
          vertexColors
          roughness={0.95}
          side={THREE.DoubleSide}
        />
      </mesh>
      {studyArea && <Line points={Array.from({ length: 97 }, (_, index) => {
        const angle = index / 96 * Math.PI * 2;
        const x = studyArea.x_m + Math.cos(angle) * studyArea.radius_m;
        const y = studyArea.y_m + Math.sin(angle) * studyArea.radius_m;
        return [x / 1000, ((heightAt(terrain, x, y) - base) / 1000) * 1.5 + .15, -y / 1000] as [number, number, number];
      })} color="#f1d49b" lineWidth={3} />}
      <gridHelper
        args={[
          Math.max(terrain.extent_m[2] - terrain.extent_m[0], terrain.extent_m[3] - terrain.extent_m[1]) / 1000 * 1.2,
          12,
          "#414141",
          "#292929",
        ]}
        position={[0, -0.08, 0]}
      />
      {["score", "illumination", "earth_visibility", "suitability"].includes(layer) && (
        <CandidateCloud
          terrain={terrain}
          points={mapCandidates}
          layer={layer}
          selected={selected}
          onSelect={onSelect}
        />
      )}
      {features.map((feature) => {
        const [x, y] = featurePoint(feature);
        if (x < terrain.extent_m[0] || x > terrain.extent_m[2] ||
            y < terrain.extent_m[1] || y > terrain.extent_m[3]) return null;
        return (
          <SceneLabel
            key={feature.id}
            text={`+ ${feature.name}`}
            position={[
              x / 1000,
              ((heightAt(terrain, x, y) - base) / 1000) * 1.5 + 0.2,
              -y / 1000,
            ]}
            width={3.2}
          />
        );
      })}
      {previewPoint && <SceneLabel text="+ Selected point" selected
        position={[0, ((heightAt(terrain, 0, 0) - base) / 1000) * 1.5 + .3, 0]} width={9} />}
      {candidates.map((site) => {
        const y =
          ((heightAt(terrain, site.x_m, site.y_m) - base) / 1000) * 1.5 + 0.12;
        const active = site.id === selected;
        const slot = compare.indexOf(site.id);
        const m = markerScale(terrain, markerSize);
        const ring = slot >= 0 ? COMPARE_COLORS[slot % COMPARE_COLORS.length] : active ? "#d4ffe1" : "#92dcb6";
        return (
          <group
            key={site.id}
            position={[site.x_m / 1000, y, -site.y_m / 1000]}
            scale={m}
          >
            <mesh rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={slot >= 0 ? [0.26, 0.4, 40] : [0.25, 0.32, 40]} />
              <meshBasicMaterial
                color={ring}
                side={THREE.DoubleSide}
              />
            </mesh>
            <SceneLabel
              text={slot >= 0 ? compareSiteLetter(slot) : String(site.rank).padStart(2, "0")}
              selected={active}
              color={slot >= 0 ? ring : undefined}
              round
              position={[0, 0.65, 0]}
              width={0.7}
              onSelect={() => onSelect(site.id)}
            />
            {sample && <StatusDots site={site} sample={sample} />}
          </group>
        );
      })}
      {sample && candidates.filter(site => site.id === selected && site.timeline.length).map(site => {
        const own = site.timeline[sampleIndexAt(site.timeline, sample.time_utc)];
        return own ? <SightLines key={site.id} terrain={terrain} site={site} sample={own} base={base} markerSize={markerSize} /> : null;
      })}
    </group>
  );
}

function comparisonFrame(terrain: TerrainData, sites?: Candidate[]) {
  if (!sites?.length) return { left: 0, top: 0, span: 600 };
  const [xmin, ymin, xmax, ymax] = terrain.extent_m;
  const x = sites.map(site => (site.x_m - xmin) / (xmax - xmin) * 600);
  const y = sites.map(site => (ymax - site.y_m) / (ymax - ymin) * 600);
  const left = Math.min(...x), right = Math.max(...x);
  const top = Math.min(...y), bottom = Math.max(...y);
  const span = Math.min(600, Math.max(60, Math.max(right - left, bottom - top) * 1.6));
  const fit = (center: number) => Math.min(600 - span, Math.max(0, center - span / 2));
  return { left: fit((left + right) / 2), top: fit((top + bottom) / 2), span };
}

export function FlatMap({
  terrain,
  candidates,
  selected,
  onSelect,
  layer,
  mapCandidates,
  psr,
  features,
  previewPoint,
  studyArea,
  compare = [],
  comparisonSites,
}: {
  terrain: TerrainData;
  candidates: Candidate[];
  selected: string | null;
  onSelect: (id: string) => void;
} & LayerOptions) {
  const [xmin, ymin, xmax, ymax] = terrain.extent_m;
  const { left, top, span } = comparisonFrame(terrain, comparisonSites);
  const scale = span / 600;
  // One shaded-relief bitmap instead of an SVG rect per DEM cell (tens of thousands at 80 m/px).
  const relief = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = terrain.width; canvas.height = terrain.height;
    const context = canvas.getContext("2d");
    if (!context) return "";
    let min = Infinity, max = -Infinity;
    for (const value of terrain.elevations_m) if (value != null) { if (value < min) min = value; if (value > max) max = value; }
    const image = context.createImageData(terrain.width, terrain.height);
    terrain.elevations_m.forEach((height, i) => {
      const shade = height == null ? 0 : Math.round(255 * (12 + ((height - min) / Math.max(1, max - min)) * 45) / 100);
      image.data.set([shade, shade, shade, height == null ? 0 : 255], i * 4);
    });
    context.putImageData(image, 0, 0);
    return canvas.toDataURL();
  }, [terrain]);
  return (
    <div className="flat-map">
      <svg
        viewBox={`${left} ${top} ${span} ${span}`}
        aria-label={previewPoint ? "Local coarse terrain centered on the selected global point" : "Top-down terrain map with candidate locations"}
        role={comparisonSites?.length ? "group" : "img"}
      >
        {relief && <image href={relief} x="0" y="0" width="600" height="600" preserveAspectRatio="none" style={{ imageRendering: "auto" }} />}
        {layer === "psr" &&
          psr &&
          psr.psr_fraction.map((fraction, i) =>
            fraction <= 0 ? null : (
              <rect
                key={`psr-${i}`}
                x={((i % psr.width) / psr.width) * 600}
                y={(Math.floor(i / psr.width) / psr.height) * 600}
                width={600 / psr.width + 0.2}
                height={600 / psr.height + 0.2}
                fill="#a09ace"
                opacity={fraction * 0.85}
              />
            ),
          )}
        {["score", "illumination", "earth_visibility", "suitability"].includes(layer) &&
          mapCandidates.map((point) => (
            <circle
              key={point.id}
              cx={((point.x_m - xmin) / (xmax - xmin)) * 600}
              cy={((ymax - point.y_m) / (ymax - ymin)) * 600}
              r={point.id === selected ? 5 : 3}
              fill={`#${pointColor(point, layer).getHexString()}`}
              stroke={point.id === selected ? "white" : "none"}
              onClick={() => onSelect(point.id)}
              className="eligible-point"
            >
              <title>
                {point.id} · score {point.score.toFixed(1)} · sunlight{" "}
                {(point.illumination_fraction * 100).toFixed(1)}% · Earth{" "}
                {(point.earth_visibility_fraction * 100).toFixed(1)}%
              </title>
            </circle>
          ))}
        {features.map((feature) => {
          const [x, y] = featurePoint(feature);
          if (x < xmin || x > xmax || y < ymin || y > ymax) return null;
          return (
            <text
              className="flat-feature-label"
              x={((x - xmin) / (xmax - xmin)) * 600 + 7}
              y={((ymax - y) / (ymax - ymin)) * 600 - 8}
              key={feature.id}
            >
              + {feature.name}
            </text>
          );
        })}
        {studyArea && <ellipse cx={(studyArea.x_m - xmin) / (xmax - xmin) * 600} cy={(ymax - studyArea.y_m) / (ymax - ymin) * 600} rx={studyArea.radius_m / (xmax - xmin) * 600} ry={studyArea.radius_m / (ymax - ymin) * 600} fill="none" stroke="#f1d49b" strokeWidth="3" />}
        {previewPoint && <g transform="translate(300 300)"><path d="M-10 0H10M0-10V10" stroke="#fff9d3" strokeWidth="3" /><text x="14" y="-12" fill="#fff9d3" fontSize="13">Selected point</text></g>}
        {candidates.map((site) => {
          const slot = compare.indexOf(site.id);
          const markerColor = slot >= 0 ? COMPARE_COLORS[slot] : undefined;
          return (
            <g
              key={site.id}
              transform={`translate(${((site.x_m - xmin) / (xmax - xmin)) * 600},${((ymax - site.y_m) / (ymax - ymin)) * 600}) scale(${scale})`}
              className={`flat-marker ${selected === site.id ? "selected" : ""}`}
              tabIndex={0}
              role="button"
              aria-label={`Inspect ${slot >= 0 ? compareSiteLabel(slot) : `candidate ${site.rank}`}`}
              onClick={() => onSelect(site.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(site.id);
                }
              }}
            >
              <circle r="14" style={markerColor ? { stroke: markerColor, strokeWidth: 2.5 } : undefined} />
              <text textAnchor="middle" dy="5">
                {slot >= 0 ? compareSiteLetter(slot) : site.rank}
              </text>
            </g>
          );
        })}
        <g transform={`translate(${left} ${top}) scale(${scale})`} stroke="#d4e4d5" fill="#e2ede3">
          <path d="M25 568v7h150v-7" fill="none" strokeWidth="2" />
          <text x="25" y="558" stroke="none" fontSize="12">
            {Number(((xmax - xmin) * scale / 4000).toPrecision(3))} km
          </text>
        </g>
      </svg>
    </div>
  );
}

export function TerrainScene({
  terrain,
  candidates,
  selected,
  onSelect,
  mode,
  layer,
  mapCandidates,
  psr,
  features,
  previewPoint,
  studyArea,
  onPick,
  sample,
  compare,
  comparisonSites,
}: {
  terrain: TerrainData;
  candidates: Candidate[];
  selected: string | null;
  onSelect: (id: string) => void;
  mode: "terrain" | "map";
} & LayerOptions) {
  const [xmin, ymin, xmax, ymax] = terrain.extent_m;
  const spanKm = Math.max(
    xmax - xmin,
    ymax - ymin,
  ) / 1000;
  const flat = (
    <FlatMap
      previewPoint={previewPoint}
      studyArea={studyArea}
      terrain={terrain}
      candidates={candidates}
      selected={selected}
      onSelect={onSelect}
      layer={layer}
      mapCandidates={mapCandidates}
      psr={psr}
      features={features}
      compare={compare}
      comparisonSites={comparisonSites}
    />
  );
  const legend = layer === "suitability" ? <SuitabilityLegend /> : null;
  const lightSite = candidates.find(site => site.id === selected) ?? candidates[0];
  const focusSite = sample ? candidates.find(site => site.id === selected) : undefined;
  const sharedFrame = comparisonSites && comparisonSites.length > 1 ? comparisonFrame(terrain, comparisonSites) : null;
  const focusPoint = sharedFrame ? {
    x_m: xmin + (sharedFrame.left + sharedFrame.span / 2) / 600 * (xmax - xmin),
    y_m: ymax - (sharedFrame.top + sharedFrame.span / 2) / 600 * (ymax - ymin),
  } : focusSite;
  const focusSpan = sharedFrame ? spanKm * sharedFrame.span / 600 : Math.min(spanKm, 40);
  const minimum = baseHeight(terrain);
  const reliefKm = useMemo(() => {
    let maximum = -Infinity;
    for (const value of terrain.elevations_m) if (value != null && value > maximum) maximum = value;
    return Number.isFinite(maximum) ? (maximum - baseHeight(terrain)) / 1000 * HEIGHT_SCALE : 0;
  }, [terrain]);
  const focus: [number, number, number] | undefined = focusPoint
    ? [focusPoint.x_m / 1000, ((heightAt(terrain, focusPoint.x_m, focusPoint.y_m) - minimum) / 1000) * HEIGHT_SCALE, -focusPoint.y_m / 1000]
    : undefined;
  const markerSize = sharedFrame ? Math.max(.25, focusSpan * 1.5 / 40) : focus ? Math.max(.3, Math.min(1.5, focusSpan / 12)) : undefined;
  const sunSample = sample && lightSite?.timeline.length
    ? lightSite.timeline[sampleIndexAt(lightSite.timeline, sample.time_utc)] ?? sample
    : sample;
  const visibleCandidates = useMemo(() => candidates.filter(site => insideTerrain(terrain, site.x_m, site.y_m)), [candidates, terrain]);
  const visiblePoints = useMemo(() => mapCandidates.filter(point => insideTerrain(terrain, point.x_m, point.y_m)), [mapCandidates, terrain]);
  const shadowFrame = focus ? { x: focus[0], z: focus[2], spanKm: Math.max(focusSpan, 2) } : undefined;
  if (mode === "map") return <>{flat}{legend}</>;
  return (
    <SceneBoundary fallback={<><p role="status">3D terrain unavailable on this device. Showing the 2D map.</p>{flat}</>}>
      <div className="terrain-3d-frame" role="img" aria-label="Interactive 3D lunar elevation terrain. Drag to orbit; scroll or pinch to zoom.">
      <Canvas
        shadows={!!sunSample}
        frameloop="demand"
        dpr={[1, 1.5]}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        camera={{
          position: focus
            ? [focus[0] + focusSpan * .45, focus[1] + focusSpan * .32, focus[2] + focusSpan * .5]
            : [(xmin + xmax) / 2000 + spanKm * .45, reliefKm * .8 + spanKm * .75, -(ymin + ymax) / 2000 + spanKm * .6],
          fov: 44,
          near: 0.1,
          far: Math.max(200, spanKm * 5),
        }}
        fallback={<><p role="status">WebGL unavailable. Showing the 2D map.</p>{flat}</>}
      >
        <color attach="background" args={["#111213"]} />
        <fog attach="fog" args={["#111213", spanKm * 2.25, spanKm * 5]} />
        {sunSample ? <>
          {/* Earthshine-level fill so shadowed ground is dark but not black. */}
          <ambientLight intensity={0.32} />
          <SunLight terrain={terrain} sample={sunSample} longitudeDeg={lightSite?.longitude_deg_east ?? 0} frame={shadowFrame} />
        </> : <>
          <ambientLight intensity={0.5} />
          <directionalLight
            position={[-12, 20, -10]}
            intensity={2.3}
            color="#ffffff"
          />
          <directionalLight
            position={[10, 4, 15]}
            intensity={0.35}
            color="#ffffff"
          />
        </>}
        <TerrainMesh
          previewPoint={previewPoint}
          studyArea={studyArea}
          onPick={onPick}
          terrain={terrain}
          candidates={visibleCandidates}
          selected={selected}
          onSelect={onSelect}
          layer={layer}
          mapCandidates={visiblePoints}
          psr={psr}
          features={features}
          sample={sample}
          compare={compare}
          markerSize={markerSize}
        />
        <Controls target={focus ?? [(xmin + xmax) / 2000, reliefKm * .45, -(ymin + ymax) / 2000]}
          minDistance={focus ? Math.min(1.5, focusSpan / 12) : Math.min(6, spanKm / 6)} maxDistance={Math.max(spanKm * 3, 8)} />
      </Canvas>
      {legend}
      {sunSample && <span className="terrain-sun-note">Lit by the Sun at {sunSample.time_utc.slice(0, 16).replace("T", " ")} UTC · Sun {sunSample.sun_elevation_deg.toFixed(1)}° up · shadows move as you scrub</span>}
      <span className="terrain-interaction-hint">{onPick ? "Click surface to select · drag to orbit · height 1.5×" : "3D elevation · drag to orbit · scroll or pinch to zoom · height 1.5×"}</span>
      </div>
    </SceneBoundary>
  );
}
