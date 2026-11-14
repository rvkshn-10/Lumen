import { Canvas, useThree } from "@react-three/fiber";
import { Line, OrbitControls } from "@react-three/drei";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { Candidate, TimeSample } from "../lib/types";
import { utcTime } from "../lib/format";
import {
  BLOCKED_COLOR, BODY_COLORS, elevationExaggeration, horizonAt, nextChange,
  skyDirection, steadyState, visibilitySegments, type Body,
} from "../lib/sky-geometry";
import { dumpRow, registerSceneDump } from "../lib/scene-parity";
import { SceneLabel } from "./SceneLabel";

const BODY_R = 10;      // Sun/Earth markers sit on this sphere
const RIDGE_R = 9.6;    // the terrain ridge sits in front of them, so it hides what it should
const SUN_RADIUS_DEG = 0.267;
const EARTH_RADIUS_DEG = 0.95;

const at = (radius: number, az: number, el: number, k: number) =>
  new THREE.Vector3(...skyDirection(az, el, k)).multiplyScalar(radius);

/** The sampled LOLA skyline as an opaque wall from the ridge line down below the tangent plane. */
function Ridge({ profile, k }: { profile: number[]; k: number }) {
  const { geometry, edge } = useMemo(() => {
    const steps = 360;
    const positions: number[] = [];
    const edgePoints: THREE.Vector3[] = [];
    for (let i = 0; i <= steps; i++) {
      const az = (i / steps) * 360;
      const top = at(RIDGE_R, az, horizonAt(profile, az), k);
      const bottom = at(RIDGE_R, az, -40, 1);
      positions.push(...top.toArray(), ...bottom.toArray());
      edgePoints.push(top);
    }
    const index: number[] = [];
    for (let i = 0; i < steps; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(index);
    return { geometry: geo, edge: edgePoints };
  }, [profile, k]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <>
    <mesh geometry={geometry} renderOrder={1}>
      <meshBasicMaterial color="#323f3b" side={THREE.DoubleSide} />
    </mesh>
    <Line points={edge} color="#a9c6a9" lineWidth={2} />
  </>;
}

function BodyTrack({ site, body, k }: { site: Candidate; body: Body; k: number }) {
  const segments = useMemo(() => visibilitySegments(site.timeline, body, { step: Math.max(1, Math.floor(site.timeline.length / 600)) }), [site, body]);
  return <>{segments.map((segment, i) => (
    <Line key={i} points={segment.points.map(p => at(BODY_R, p.azimuth, p.elevation, k))}
      color={segment.visible ? BODY_COLORS[body] : BLOCKED_COLOR} lineWidth={segment.visible ? 2 : 1.2}
      dashed={!segment.visible} dashSize={.25} gapSize={.2} transparent opacity={segment.visible ? .85 : .6} />
  ))}</>;
}

/**
 * The body at its true angular size (so the ridge clips it exactly where the
 * terrain does), plus a fixed-size ring that carries the API's visible/blocked
 * state and stays readable even when the disk is hidden.
 */
function BodyMarker({ body, sample, k }: { body: Body; sample: TimeSample; k: number }) {
  const az = body === "sun" ? sample.sun_azimuth_deg : sample.earth_azimuth_deg;
  const el = body === "sun" ? sample.sun_elevation_deg : sample.earth_elevation_deg;
  const visible = body === "sun" ? sample.sun_visible : sample.earth_visible;
  const position = at(BODY_R, az, el, k);
  const radius = BODY_R * Math.tan(((body === "sun" ? SUN_RADIUS_DEG : EARTH_RADIUS_DEG) * Math.PI) / 180);
  const ring = useMemo(() => Array.from({ length: 49 }, (_, i) => {
    const a = (i / 48) * Math.PI * 2;
    return new THREE.Vector3(Math.cos(a) * .55, Math.sin(a) * .55, 0);
  }), []);
  return <group position={position} onUpdate={group => group.lookAt(0, 0, 0)}>
    <mesh renderOrder={2}><circleGeometry args={[Math.max(radius, .02), 48]} /><meshBasicMaterial color={BODY_COLORS[body]} side={THREE.DoubleSide} /></mesh>
    <Line points={ring} color={visible ? BODY_COLORS[body] : BLOCKED_COLOR} lineWidth={visible ? 2.5 : 1.5}
      dashed={!visible} dashSize={.12} gapSize={.1} depthTest={false} renderOrder={3} />
  </group>;
}

/** First-person camera at the site: drag to look around, no zoom or pan. */
function LookAround({ initial }: { initial: THREE.Vector3 }) {
  const { camera } = useThree();
  useEffect(() => {
    const d = initial.clone().setY(Math.max(.08, initial.y)).normalize();
    camera.position.copy(d.multiplyScalar(-0.01));
    camera.lookAt(0, 0, 0);
  }, [camera, initial]);
  return <OrbitControls target={[0, 0, 0]} enableZoom={false} enablePan={false} rotateSpeed={-0.35}
    minPolarAngle={Math.PI * .32} maxPolarAngle={Math.PI * .72} />;
}

export function SkyScene({ site, sample }: { site: Candidate; sample: TimeSample }) {
  const profile = useMemo(() => site.horizon.map(h => h.elevation_deg), [site]);
  const k = useMemo(() => elevationExaggeration(site), [site]);
  const sunHorizon = horizonAt(profile, sample.sun_azimuth_deg);
  const earthHorizon = horizonAt(profile, sample.earth_azimuth_deg);
  // Face whichever body is up when the view opens (Earth first: contact is the usual question).
  const initial = useMemo(() => {
    const body = sample.earth_visible || !sample.sun_visible ? "earth" : "sun";
    return at(1, body === "sun" ? sample.sun_azimuth_deg : sample.earth_azimuth_deg, 4, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.id]);

  useEffect(() => registerSceneDump(`sky:${site.id}`, () => [dumpRow("sky", site.id, sample, {
    sunHorizon, earthHorizon, sunVisible: sample.sun_visible, earthVisible: sample.earth_visible,
  })]), [site.id, sample, sunHorizon, earthHorizon]);

  const status = (body: Body) => {
    const steady = steadyState(site.timeline, body);
    const next = nextChange(site.timeline, sample.time_utc, body);
    return next?.label ?? steady ?? (body === "sun" ? "No further sunrise or sunset in window" : "No further Earthrise or Earthset in window");
  };
  const reading = (body: Body) => {
    const el = body === "sun" ? sample.sun_elevation_deg : sample.earth_elevation_deg;
    const h = body === "sun" ? sunHorizon : earthHorizon;
    const visible = body === "sun" ? sample.sun_visible : sample.earth_visible;
    const clearance = el - h;
    return { el, h, visible, clearance };
  };

  return (
    <div className="scene-wrapper sky-context terrain-sky">
      <Canvas dpr={[1, 1.7]} camera={{ fov: 62, near: .001, far: 100 }}
        fallback={<div className="scene-empty">Use the horizon panorama below for the same local sky data.</div>}>
        <color attach="background" args={["#070b0d"]} />
        <LookAround initial={initial} />
        <Ridge profile={profile} k={k} />
        <BodyTrack site={site} body="sun" k={k} />
        <BodyTrack site={site} body="earth" k={k} />
        <BodyMarker body="sun" sample={sample} k={k} />
        <BodyMarker body="earth" sample={sample} k={k} />
        {[0, 90, 180, 270].map((az, i) => (
          <SceneLabel key={az} text={["N", "E", "S", "W"][i]} position={at(RIDGE_R * .85, az, -3, 1).toArray() as [number, number, number]} width={1.5} />
        ))}
        {(["sun", "earth"] as const).map(body => {
          const r = reading(body);
          const az = body === "sun" ? sample.sun_azimuth_deg : sample.earth_azimuth_deg;
          const p = at(BODY_R, az, r.el, k);
          return <SceneLabel key={body} text={`${body === "sun" ? "Sun" : "Earth"} ${r.el.toFixed(1)}° · ${r.visible ? "in view" : "behind terrain"}`}
            color={r.visible ? BODY_COLORS[body] : "#b9c2bf"} position={[p.x, p.y + 1.1, p.z]} width={3.6} />;
        })}
      </Canvas>
      <div className="sky-context-caption">
        <span className="eyebrow">VIEW FROM SITE {site.rank ? `· CANDIDATE ${site.rank}` : ""}</span>
        <strong>{utcTime(sample.time_utc)}</strong>
        {(["sun", "earth"] as const).map(body => {
          const r = reading(body);
          return <span key={body} className={`sky-status ${body} ${r.visible ? "is-visible" : "is-blocked"}`}>
            <b>{body === "sun" ? "Sun" : "Earth"}</b> {r.visible ? "in view" : "behind terrain"} · {Math.abs(r.clearance).toFixed(1)}° {r.clearance >= 0 ? "above" : "below"} the ridge · {status(body)}
          </span>;
        })}
        <span className="muted">Move the Scene time slider to change the hour.</span>
      </div>
      <div className="scene-caption">
        Real terrain horizon (LOLA, 5° bins) · solid = in view, dashed grey = behind terrain · heights ×{k} for legibility · drag to look around
      </div>
    </div>
  );
}
