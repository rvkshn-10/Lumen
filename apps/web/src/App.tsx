import { useLayoutEffect, useState } from "react";
import { GuidedPlanner } from "./components/GuidedPlanner";
import { applyAppearance, readAppearance } from "./lib/appearance";

export default function App() {
  const [appearance, setAppearance] = useState(readAppearance);
  useLayoutEffect(() => applyAppearance(appearance), [appearance]);

  return <main id="top">
    <GuidedPlanner appearance={appearance} onAppearance={setAppearance} />
  </main>;
}
