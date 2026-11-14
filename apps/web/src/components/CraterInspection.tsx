import { useState } from "react";
import sample from "../data/connecting-ridge-craters.json";
import "./crater-inspection.css";

type MapPoint = { x_m: number; y_m: number };

export const CONNECTING_RIDGE_ID = "shackleton-connecting-ridge";
const { left, top, width, height, metersPerPixel } = sample.crop;

function samplePixel(point: MapPoint) {
  return { x: (point.x_m - left) / metersPerPixel, y: (top - point.y_m) / metersPerPixel };
}

export function isInCraterSample(point: MapPoint) {
  const { x, y } = samplePixel(point);
  return x >= 0 && x < width && y >= 0 && y < height;
}

export function CraterInspection({ point }: { point?: MapPoint }) {
  const [opened, setOpened] = useState(false);
  const [showCandidates, setShowCandidates] = useState(true);
  const marker = point && samplePixel(point);

  return <details className="crater-inspection" onToggle={event => setOpened(event.currentTarget.open)}>
    <summary>Inspect crater candidates at Connecting Ridge</summary>
    {opened ? <>
      <p>Intel OpenVINO identified {sample.boxes.length} possible craters in this {width} × {height} m crop near Shackleton. NASA’s Lunar Reconnaissance Orbiter imagery has a {metersPerPixel} m pixel scale here.</p>
      <label className="crater-inspection-control">
        <input type="checkbox" checked={showCandidates} onChange={event => setShowCandidates(event.currentTarget.checked)} />
        Show crater candidates
      </label>
      <figure className="crater-crop">
        <div className="crater-crop-image">
          <img src={`${import.meta.env.BASE_URL}assets/connecting-ridge-nac.png`}
            width={width} height={height}
            alt="Orbital image of cratered lunar terrain on the ridge between Shackleton and de Gerlache" />
          {showCandidates ? sample.boxes.map(([x1, y1, x2, y2]) => (
            <span aria-hidden="true" className="crater-candidate" key={`${x1},${y1},${x2},${y2}`} style={{
              left: `${x1 / width * 100}%`, top: `${y1 / height * 100}%`,
              width: `${(x2 - x1) / width * 100}%`, height: `${(y2 - y1) / height * 100}%`,
            }} />
          )) : null}
          {marker ? <span aria-hidden="true" className="crater-site-marker"
            style={{ left: `${marker.x / width * 100}%`, top: `${marker.y / height * 100}%` }} /> : null}
        </div>
        {marker ? <figcaption>The yellow marker is the selected site.</figcaption> : null}
      </figure>
      <p>The displayed predictions have a confidence score of at least {sample.minimumConfidence} and an estimated box at least {sample.minimumSideM} m on each side before cropping. This crop has no independent crater labels, and shadowed terrain can hide features. Candidate rankings use the planner’s existing terrain and visibility calculations. Use this view for visual inspection.</p>
      <p>Image credit NASA/GSFC/ASU and USGS. <a href={sample.imageSource} target="_blank" rel="noreferrer">LROC source image</a> · <a href={sample.modelSource} target="_blank" rel="noreferrer">Fassett crater model and data</a></p>
    </> : null}
  </details>;
}
