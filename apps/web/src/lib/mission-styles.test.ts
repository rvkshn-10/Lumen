import { describe, expect, it } from "vitest";
import { DEFAULT_REQUEST } from "./missions";
import { MISSION_STYLES, activeStyle, applyStyle } from "./mission-styles";

describe("mission styles", () => {
  it("applies a style's weights and limits and recognises it again", () => {
    for (const style of MISSION_STYLES) {
      const request = applyStyle(structuredClone(DEFAULT_REQUEST), style);
      expect(request.hard_constraints).toEqual(style.hard_constraints);
      expect(activeStyle(request)?.id).toBe(style.id);
    }
  });
  it("does not share objects with the style definitions", () => {
    const request = applyStyle(structuredClone(DEFAULT_REQUEST), MISSION_STYLES[0]);
    request.preferences.illumination = 1;
    expect(MISSION_STYLES[0].preferences.illumination).not.toBe(1);
  });
});
