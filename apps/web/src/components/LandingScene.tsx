import { Html, Line, OrbitControls, useTexture } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { ReplayTerrain, TrajectoryDescent } from "../lib/experience-api";
import { SceneBoundary } from "./SceneBoundary";

/*
 * 3D view of a historic landing site. Data rules — nothing here is invented:
 *  - Terrain: the backend's elevation grid around the site, at true scale.
 *  - Sun and Earth: modeled azimuth/elevation from the replay (JPL DE440).
 *    Sizes use true angular radii from NASA fact-sheet values.
 *  - Descent: only shown when NASA published a trajectory (NAIF PDS SPICE or
 *    JPL Horizons); positions are the published samples, no interpolation.
 * The lander shape is a simplified stand-in and is labelled as such.
 * Units are metres. North is −z, east is +x.
 */

export type LanderFamily = "apollo" | "classic" | "modern";
export function landerFamily(siteId: string): LanderFamily {
  if (siteId.startsWith("apollo")) return "apollo";
  if (siteId.startsWith("surveyor") || siteId.startsWith("luna")) return "classic";
  return "modern";
}

type Body = { azimuth?: number; elevation?: number; visible?: boolean };
type Props = {
  siteId: string;
  terrain?: ReplayTerrain;
  sun: Body;
  earth: Body;
  /** Replay time (ms since epoch). */
  time: number;
  /** NASA descent samples, when published. */
  descent?: TrajectoryDescent;
  /** Increment to play the NASA descent once. */
  descentKey: number;
};

const SKY_DISTANCE = 60_000;
// True angular radii from NASA fact sheets: Sun radius 695,700 km at 1 AU (149.6 million km);
// Earth radius 6,371 km at the mean Earth–Moon distance (384,400 km).
const SUN_ANGULAR_RADIUS = Math.asin(695_700 / 149_600_000);
const EARTH_ANGULAR_RADIUS = Math.asin(6_371 / 384_400);
const DESCENT_PLAYBACK_MS = 20_000;

function direction(azimuthDeg: number, elevationDeg: number) {
  const az = azimuthDeg * Math.PI / 180, el = elevationDeg * Math.PI / 180;
  return new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
}
/** Local east/north/up (km) → scene metres. */
function enuToScene([east, north, up]: [number, number, number]) {
  return new THREE.Vector3(east * 1000, up * 1000, -north * 1000);
}

/** Elevation grid around the site at true vertical scale, centred on the site's own grid value. */
function Terrain({ terrain }: { terrain?: ReplayTerrain }) {
  const geometry = useMemo(() => {
    const columns = terrain?.width ?? 2, rows = terrain?.height ?? 2;
    const [left, bottom, right, top] = terrain?.extent_m ?? [-40000, -40000, 40000, 40000];
    const plane = new THREE.PlaneGeometry(right - left, top - bottom, columns - 1, rows - 1);
    plane.rotateX(-Math.PI / 2); // grid row 0 (north) ends up at −z
    if (terrain) {
      const p = plane.getAttribute("position");
      const centre = terrain.elevations_m[Math.floor(rows / 2) * columns + Math.floor(columns / 2)];
      for (let i = 0; i < p.count; i++) p.setY(i, terrain.elevations_m[i] - centre);
    }
    plane.computeVertexNormals();
    return plane;
  }, [terrain]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <mesh geometry={geometry} receiveShadow>
    <meshStandardMaterial color="#8a8680" roughness={1} metalness={0} />
  </mesh>;
}

const FOIL = { color: "#d4a83e", metalness: .35, roughness: .38 }; // low metalness: no environment map to reflect
const GREY = { color: "#c4c2bd", metalness: .15, roughness: .6 };
const DARK = { color: "#2b2f36", metalness: .4, roughness: .5 };
const PANEL = { color: "#25385e", metalness: .3, roughness: .35 };

function Leg({ angle, reach, height, pad = .45 }: { angle: number; reach: number; height: number; pad?: number }) {
  const foot = new THREE.Vector3(Math.cos(angle) * reach, pad * .2, Math.sin(angle) * reach);
  const hip = new THREE.Vector3(Math.cos(angle) * reach * .45, height, Math.sin(angle) * reach * .45);
  const mid = hip.clone().add(foot).multiplyScalar(.5), length = hip.distanceTo(foot);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), hip.clone().sub(foot).normalize());
  return <group>
    <mesh position={mid} quaternion={quaternion} castShadow><cylinderGeometry args={[.07, .07, length, 8]} /><meshStandardMaterial {...GREY} /></mesh>
    <mesh position={foot} castShadow><cylinderGeometry args={[pad, pad, .12, 16]} /><meshStandardMaterial {...GREY} /></mesh>
  </group>;
}

function ApolloLander() {
  return <group>
    {[0, 1, 2, 3].map(i => <Leg key={i} angle={Math.PI / 4 + i * Math.PI / 2} reach={4.3} height={1.5} pad={.48} />)}
    <mesh position={[0, 1.75, 0]} castShadow><cylinderGeometry args={[2.1, 2.1, 1.6, 8]} /><meshStandardMaterial {...FOIL} /></mesh>
    <mesh position={[0, 3.3, -.15]} castShadow><boxGeometry args={[2.9, 1.9, 2.4]} /><meshStandardMaterial {...GREY} /></mesh>
    <mesh position={[0, 3.6, 1.1]} rotation={[Math.PI / 2, 0, 0]} castShadow><cylinderGeometry args={[.9, .9, .6, 8]} /><meshStandardMaterial {...GREY} /></mesh>
    <mesh position={[.9, 4.55, -.4]} castShadow><cylinderGeometry args={[.04, .04, 1.1, 6]} /><meshStandardMaterial {...DARK} /></mesh>
    <mesh position={[.9, 5.2, -.4]} rotation={[.5, 0, .3]} castShadow><coneGeometry args={[.35, .2, 16, 1, true]} /><meshStandardMaterial {...GREY} side={THREE.DoubleSide} /></mesh>
  </group>;
}

function ClassicLander() {
  return <group>
    {[0, 1, 2].map(i => <Leg key={i} angle={Math.PI / 2 + i * Math.PI * 2 / 3} reach={2.1} height={1} pad={.32} />)}
    <mesh position={[0, 1.1, 0]} castShadow><cylinderGeometry args={[.85, .85, .5, 3]} /><meshStandardMaterial {...GREY} /></mesh>
    <mesh position={[0, 1.45, 0]} castShadow><sphereGeometry args={[.42, 20, 14]} /><meshStandardMaterial {...FOIL} /></mesh>
    <mesh position={[0, 2.3, 0]} castShadow><cylinderGeometry args={[.05, .05, 1.8, 6]} /><meshStandardMaterial {...DARK} /></mesh>
    <mesh position={[0, 3.1, .25]} rotation={[-.9, 0, 0]} castShadow><boxGeometry args={[1.2, .03, .9]} /><meshStandardMaterial {...PANEL} /></mesh>
  </group>;
}

function ModernLander() {
  return <group>
    {[0, 1, 2, 3].map(i => <Leg key={i} angle={Math.PI / 4 + i * Math.PI / 2} reach={2.6} height={1.1} pad={.36} />)}
    <mesh position={[0, 2.2, 0]} castShadow><cylinderGeometry args={[1.35, 1.35, 2.3, 6]} /><meshStandardMaterial {...FOIL} /></mesh>
    <mesh position={[0, 3.45, 0]} castShadow><cylinderGeometry args={[1.1, 1.35, .2, 6]} /><meshStandardMaterial {...GREY} /></mesh>
    {[-1, 1].map(side => <mesh key={side} position={[side * 1.55, 2.3, 0]} castShadow>
      <boxGeometry args={[.05, 1.8, 1.4]} /><meshStandardMaterial {...PANEL} /></mesh>)}
  </group>;
}

/** Index of the last NASA sample at or before `time`; −1 before the first sample. */
function sampleAt(times: number[], time: number) {
  let low = 0, high = times.length - 1, found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (times[mid] <= time) { found = mid; low = mid + 1; } else high = mid - 1;
  }
  return found;
}

function Lander({ family, time, descent, descentKey, onReadout }: {
  family: LanderFamily; time: number; descent?: TrajectoryDescent; descentKey: number;
  onReadout: (readout: { utc: string; altitudeKm: number } | null) => void;
}) {
  const { invalidate, camera, controls } = useThree();
  const [playStart, setPlayStart] = useState<number | null>(null);
  const [playIndex, setPlayIndex] = useState(0);
  const touchdown = descent ? Date.parse(descent.touchdown_utc) : NaN;

  useEffect(() => { if (descentKey > 0 && descent) { setPlayStart(performance.now()); invalidate(); } }, [descentKey, descent, invalidate]);
  useFrame(() => {
    if (playStart == null || !descent) return;
    const fraction = (performance.now() - playStart) / DESCENT_PLAYBACK_MS;
    if (fraction >= 1) { setPlayStart(null); return; }
    const span = descent.t_ms[descent.t_ms.length - 1] - descent.t_ms[0];
    setPlayIndex(Math.max(0, sampleAt(descent.t_ms, descent.t_ms[0] + span * fraction)));
    invalidate();
  });

  // Which NASA sample (if any) places the lander: playback, or the replay time.
  let index = -1, onSurface = true, hidden = false;
  if (descent && playStart != null) { index = playIndex; onSurface = false; }
  else if (descent && time < touchdown) {
    index = sampleAt(descent.t_ms, time);
    onSurface = false;
    hidden = index < 0; // before NASA's descent record starts: no position to show
  }
  const position = index >= 0 && descent ? enuToScene(descent.enu_km[index]) : new THREE.Vector3();

  useEffect(() => {
    onReadout(index >= 0 && descent ? { utc: new Date(descent.t_ms[index]).toISOString(), altitudeKm: descent.altitude_km[index] } : null);
  }, [index, descent, onReadout]);

  // Frame the lander: aim at it and pull back in proportion to its NASA altitude,
  // keeping the user's viewing direction. On the surface, return to a close view.
  const altitudeM = index >= 0 && descent ? descent.altitude_km[index] * 1000 : 0;
  useEffect(() => {
    const orbit = controls as unknown as { target?: THREE.Vector3; update?: () => void } | null;
    if (!orbit?.target) return;
    const aim = onSurface ? new THREE.Vector3(0, family === "classic" ? 1.6 : 3, 0) : position.clone();
    const offset = camera.position.clone().sub(orbit.target);
    const distance = onSurface ? Math.min(Math.max(offset.length(), 8), 60) : Math.min(Math.max(altitudeM * 1.4, 40), 300_000);
    if (offset.lengthSq() < 1e-6) offset.set(1, .4, 1);
    orbit.target.copy(aim);
    camera.position.copy(aim).add(offset.setLength(distance));
    orbit.update?.();
    invalidate();
  }, [index, onSurface]); // eslint-disable-line react-hooks/exhaustive-deps

  if (hidden) return null;
  return <group position={position}>
    {family === "apollo" ? <ApolloLander /> : family === "classic" ? <ClassicLander /> : <ModernLander />}
    {!onSurface && <Html center zIndexRange={[20, 0]}><span className="landing-lander-marker" aria-hidden="true" /></Html>}
  </group>;
}

function DescentTrack({ descent }: { descent: TrajectoryDescent }) {
  const points = useMemo(() => descent.enu_km.map(enuToScene), [descent]);
  return points.length > 1 ? <Line points={points} color="#e2b04a" lineWidth={2} transparent opacity={.85} /> : null;
}

function SkyBodies({ sun, earth }: { sun: Body; earth: Body }) {
  const earthTexture = useTexture("/assets/earth-color.jpg");
  const sunDir = sun.azimuth != null && sun.elevation != null ? direction(sun.azimuth, sun.elevation) : null;
  const earthDir = earth.azimuth != null && earth.elevation != null ? direction(earth.azimuth, earth.elevation) : null;
  const light = useRef<THREE.DirectionalLight>(null);
  const sunUp = (sun.elevation ?? -90) > -SUN_ANGULAR_RADIUS * 180 / Math.PI;
  useEffect(() => { light.current?.target.position.set(0, 0, 0); light.current?.target.updateMatrixWorld(); }, []);
  return <>
    {sunDir && <directionalLight ref={light} position={sunDir.clone().multiplyScalar(80)} intensity={sunUp ? 2.6 : 0} castShadow
      shadow-mapSize={[2048, 2048]} shadow-bias={-.0004}
      shadow-camera-left={-30} shadow-camera-right={30} shadow-camera-top={30} shadow-camera-bottom={-30} shadow-camera-near={1} shadow-camera-far={300} />}
    <hemisphereLight args={["#9fb4d6", "#3a3732", earth.visible ? .16 : .06]} />
    {sunDir && <group position={sunDir.clone().multiplyScalar(SKY_DISTANCE)}>
      <mesh><sphereGeometry args={[SKY_DISTANCE * Math.tan(SUN_ANGULAR_RADIUS), 24, 16]} /><meshBasicMaterial color="#fff6e0" /></mesh>
      <Html center zIndexRange={[20, 0]} position={[0, -SKY_DISTANCE * .02, 0]}><span className={`landing-sky-label${sunUp ? "" : " below"}`}>Sun {sun.elevation!.toFixed(1)}°</span></Html>
    </group>}
    {earthDir && <group position={earthDir.clone().multiplyScalar(SKY_DISTANCE)}>
      <mesh rotation={[0, Math.PI, 0]}><sphereGeometry args={[SKY_DISTANCE * Math.tan(EARTH_ANGULAR_RADIUS), 32, 24]} /><meshStandardMaterial map={earthTexture} emissive="#14304f" emissiveIntensity={.5} /></mesh>
      <Html center zIndexRange={[20, 0]} position={[0, -SKY_DISTANCE * .035, 0]}><span className={`landing-sky-label${earth.visible ? "" : " below"}`}>Earth {earth.elevation!.toFixed(1)}°</span></Html>
    </group>}
  </>;
}

function Compass() {
  return <>{([["N", 0], ["E", 90], ["S", 180], ["W", 270]] as const).map(([label, az]) => {
    const p = direction(az, 0).multiplyScalar(60);
    return <Html key={label} position={[p.x, 1.5, p.z]} center zIndexRange={[10, 0]}><span className="landing-compass">{label}</span></Html>;
  })}</>;
}

function CameraRig({ sunAzimuth, family }: { sunAzimuth?: number; family: LanderFamily }) {
  const { camera, controls } = useThree();
  // Set the orbit target once here, not as a prop: a prop would be re-applied on every
  // parent render and pull the camera away from a descending lander.
  const targeted = useRef(false);
  useEffect(() => {
    const orbit = controls as unknown as { target?: THREE.Vector3; update?: () => void } | null;
    if (!orbit?.target || targeted.current) return;
    targeted.current = true;
    orbit.target.set(0, family === "classic" ? 1.6 : 3, 0);
    orbit.update?.();
  }, [controls, family]);
  // Start with the Sun behind the viewer so the lit side of the lander faces the camera.
  useEffect(() => {
    const from = direction(((sunAzimuth ?? 135) + 25) % 360, 14).multiplyScalar(family === "apollo" ? 19 : family === "modern" ? 15 : 10);
    camera.position.set(from.x, from.y + 3, from.z);
    camera.lookAt(0, family === "classic" ? 1.6 : 3, 0);
  }, [camera]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export default function LandingScene({ siteId, terrain, sun, earth, time, descent, descentKey }: Props) {
  const family = landerFamily(siteId);
  const [readout, setReadout] = useState<{ utc: string; altitudeKm: number } | null>(null);
  const fallback = <div className="scene-empty" role="status"><p>The 3D landing view could not load. The replay values below are unaffected.</p></div>;
  const beforeRecord = descent ? time < descent.t_ms[0] : false;
  const label = `3D view of the landing site. Sun ${sun.elevation?.toFixed(1) ?? "unknown"}° above the horizon${earth.elevation != null ? `, Earth ${earth.elevation.toFixed(1)}°` : ""}.`;
  return <div className="landing-scene terrain-3d-frame" role="img" aria-label={label}>
    <SceneBoundary fallback={fallback}>
      <Canvas shadows frameloop="demand" dpr={[1, 1.75]} gl={{ logarithmicDepthBuffer: true, antialias: true }}
        camera={{ fov: 45, near: .1, far: 2_000_000, position: [18, 9, 18] }} fallback={fallback}>
        <color attach="background" args={["#03050a"]} />
        <Suspense fallback={null}>
          <SkyBodies sun={sun} earth={earth} />
        </Suspense>
        <Terrain terrain={terrain} />
        {descent && <DescentTrack descent={descent} />}
        <Lander family={family} time={time} descent={descent} descentKey={descentKey} onReadout={setReadout} />
        <Compass />
        <CameraRig sunAzimuth={sun.azimuth} family={family} />
        <OrbitControls makeDefault minDistance={5} maxDistance={400_000} maxPolarAngle={Math.PI / 2 - .03} enablePan={false} />
      </Canvas>
    </SceneBoundary>
    {readout && <p className="landing-scene-readout">NASA sample {readout.utc.slice(11, 19)} UTC · {readout.altitudeKm.toFixed(2)} km above the touchdown point</p>}
    {beforeRecord && <p className="landing-scene-readout">Before NASA's descent record begins: no lander position to show</p>}
    <p className="landing-scene-caption">Terrain and Sun/Earth at true scale · simplified lander shape{descent ? " · gold line: NASA descent track" : ""} · drag to look around</p>
  </div>;
}
