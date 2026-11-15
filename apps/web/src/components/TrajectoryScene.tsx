import { Html, Line, OrbitControls, useTexture } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import type { Trajectory } from "../lib/experience-api";
import { utcTime } from "../lib/format";
import { SceneBoundary } from "./SceneBoundary";

/*
 * Earth-centered view of a lander's NASA trajectory. Every plotted point is a
 * sample from the NASA source (NAIF PDS SPICE archive or JPL Horizons); the Moon
 * positions come from JPL DE440. No interpolation or fitting: the marker jumps
 * between published samples, and gaps in NASA coverage are left as gaps.
 *
 * Scene units: 1 = 1,000 km. J2000 z (celestial north) points up.
 */

const KM = 1 / 1000;
const EARTH_RADIUS_KM = 6371.0; // NASA Earth fact sheet, volumetric mean radius
const MOON_RADIUS_KM = 1737.4; // NASA Moon fact sheet, volumetric mean radius

function toScene([x, y, z]: [number, number, number]) {
  return new THREE.Vector3(x * KM, z * KM, -y * KM);
}

type Sample = { t: number; segment: number; index: number };

function Earth() {
  const texture = useTexture("/assets/earth-color.jpg");
  return <mesh rotation={[0, 0, 0]}>
    <sphereGeometry args={[EARTH_RADIUS_KM * KM, 48, 32]} />
    <meshStandardMaterial map={texture} emissive="#0d2238" emissiveIntensity={.6} />
  </mesh>;
}

function Moon({ position }: { position: THREE.Vector3 }) {
  const texture = useTexture("/assets/moon-color.jpg");
  return <mesh position={position}>
    <sphereGeometry args={[MOON_RADIUS_KM * KM, 40, 28]} />
    <meshStandardMaterial map={texture} emissive="#222" emissiveIntensity={.5} />
  </mesh>;
}

function Fit({ radius }: { radius: number }) {
  const { camera } = useThree();
  useEffect(() => {
    const distance = radius / Math.sin((45 / 2) * Math.PI / 180) * 1.05;
    camera.position.set(distance * .35, distance * .55, distance * .75);
    camera.lookAt(0, 0, 0);
    (camera as THREE.PerspectiveCamera).far = distance * 6;
    camera.updateProjectionMatrix();
  }, [camera, radius]);
  return null;
}

export default function TrajectoryScene({ trajectory }: { trajectory: Trajectory }) {
  const samples = useMemo<Sample[]>(() => trajectory.segments.flatMap((segment, s) =>
    segment.t_ms.map((t, index) => ({ t, segment: s, index }))), [trajectory]);
  const [position, setPosition] = useState(samples.length - 1);
  const [playing, setPlaying] = useState(false);
  useEffect(() => { setPosition(samples.length - 1); setPlaying(false); }, [samples]);
  useEffect(() => {
    if (!playing) return;
    if (position >= samples.length - 1) { setPlaying(false); return; }
    const timer = window.setTimeout(() => setPosition(value => Math.min(samples.length - 1, value + 4)), 40);
    return () => window.clearTimeout(timer);
  }, [playing, position, samples.length]);

  const paths = useMemo(() => trajectory.segments.map(segment => segment.spacecraft_km.map(toScene)), [trajectory]);
  const moonPath = useMemo(() => trajectory.segments.flatMap(segment => segment.moon_km.map(toScene)), [trajectory]);
  const radius = useMemo(() => Math.max(...[...paths.flat(), ...moonPath].map(point => point.length())) + MOON_RADIUS_KM * KM * 4, [paths, moonPath]);

  const current = samples[position];
  const segment = trajectory.segments[current.segment];
  const craft = segment.spacecraft_km[current.index], moon = segment.moon_km[current.index];
  const earthDistance = Math.hypot(...craft);
  const moonDistance = Math.hypot(craft[0] - moon[0], craft[1] - moon[1], craft[2] - moon[2]);
  const gaps = trajectory.segments.length - 1;

  return <section className="trajectory-view" aria-label={`Path of ${trajectory.name} from Earth`}>
    <div className="trajectory-scene terrain-3d-frame">
      <SceneBoundary fallback={<div className="scene-empty" role="status"><p>The 3D path could not load. The values below are unaffected.</p></div>}>
        <Canvas frameloop="demand" dpr={[1, 1.75]} camera={{ fov: 45, near: .5, far: 5000 }} gl={{ antialias: true }}>
          <color attach="background" args={["#03050a"]} />
          <ambientLight intensity={.35} />
          <directionalLight position={[400, 200, 300]} intensity={1.6} />
          <Suspense fallback={null}>
            <Earth />
            <Moon position={toScene(moon)} />
          </Suspense>
          <Line points={moonPath} color="#8a8f99" lineWidth={1} dashed dashSize={4} gapSize={3} />
          {paths.map((points, i) => points.length > 1 && <Line key={i} points={points} color="#e2b04a" lineWidth={2} />)}
          <mesh position={toScene(craft)}><sphereGeometry args={[radius / 140, 16, 12]} /><meshBasicMaterial color="#fff2c4" /></mesh>
          <Html position={toScene(craft)} center zIndexRange={[20, 0]}><span className="landing-sky-label trajectory-label">{trajectory.name.split(" ")[0]}</span></Html>
          <Html position={[0, -EARTH_RADIUS_KM * KM * 2.2, 0]} center zIndexRange={[20, 0]}><span className="landing-sky-label">Earth</span></Html>
          <Html position={toScene(moon).add(new THREE.Vector3(0, -MOON_RADIUS_KM * KM * 3.5, 0))} center zIndexRange={[20, 0]}><span className="landing-sky-label">Moon</span></Html>
          <Fit radius={radius} />
          <OrbitControls makeDefault enablePan={false} minDistance={EARTH_RADIUS_KM * KM * 3} maxDistance={radius * 5} />
        </Canvas>
      </SceneBoundary>
      <p className="landing-scene-caption">Earth-centered J2000 · Earth and Moon to scale · drag to rotate</p>
    </div>
    <div className="clps-replay-controls">
      <button className="secondary-button" onClick={() => {
        if (playing) { setPlaying(false); return; }
        if (position >= samples.length - 1) setPosition(0);
        setPlaying(true);
      }}>{playing ? "Pause path" : "Play path"}</button>
    </div>
    <label className="field">NASA sample · <time dateTime={new Date(current.t).toISOString()}>{utcTime(new Date(current.t).toISOString())}</time>
      <input type="range" min={0} max={samples.length - 1} value={position} aria-label="Trajectory sample"
        aria-valuetext={utcTime(new Date(current.t).toISOString())}
        onChange={event => { setPlaying(false); setPosition(Number(event.target.value)); }} />
    </label>
    <dl className="clps-mission-facts clps-replay-values">
      <div><dt>Distance from Earth's center</dt><dd>{Math.round(earthDistance).toLocaleString()} km</dd></div>
      <div><dt>Distance from the Moon's center</dt><dd>{Math.round(moonDistance).toLocaleString()} km</dd></div>
    </dl>
    <p className="field-hint">
      {samples.length.toLocaleString()} samples from {new Date(samples[0].t).toISOString().slice(0, 10)} to touchdown at {utcTime(trajectory.descent.touchdown_utc)}.
      {gaps > 0 && ` The NASA record has ${gaps} gap${gaps === 1 ? "" : "s"}; they are left blank rather than filled in.`}
      {" "}Source: <a href={trajectory.source.url} target="_blank" rel="noreferrer">{trajectory.source.name}</a>
      {trajectory.source.naif_id != null && ` (NAIF ID ${trajectory.source.naif_id})`}
      {trajectory.source.horizons_id != null && ` (Horizons ID ${trajectory.source.horizons_id})`}. Moon positions: JPL DE440.
    </p>
    {trajectory.source.files && <details className="advanced-mission"><summary>NASA files used</summary>
      <ul>{trajectory.source.files.map(file => <li key={file.file}><a href={file.url} target="_blank" rel="noreferrer">{file.file}</a> <small>sha256 {file.sha256.slice(0, 12)}…</small></li>)}</ul>
    </details>}
  </section>;
}
