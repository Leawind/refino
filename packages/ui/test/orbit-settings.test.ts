import { describe, expect, it } from "vitest";
import {
  clampOrbitSetting,
  clampOrbitTextScale,
  ORBIT_SETTINGS_DEFAULT,
  ORBIT_SETTING_LIMITS,
  ORBIT_TEXT_SCALE_DEFAULT,
  ORBIT_TEXT_SCALE_MAX,
  ORBIT_TEXT_SCALE_MIN,
} from "../src/graph/orbit/settings";

/**
 * Orbit view settings (ui DESIGN.md, "三维视图"): every slider multiplies the
 * tuned baseline, so the baseline must itself be reachable and a corrupted
 * preference must never leave the scene with a value outside its range.
 */

describe("orbit settings", () => {
  it("keeps every baseline inside its own range", () => {
    for (const key of Object.keys(ORBIT_SETTINGS_DEFAULT) as Array<
      keyof typeof ORBIT_SETTINGS_DEFAULT
    >) {
      const limit = ORBIT_SETTING_LIMITS[key];
      expect(ORBIT_SETTINGS_DEFAULT[key]).toBeGreaterThanOrEqual(limit.min);
      expect(ORBIT_SETTINGS_DEFAULT[key]).toBeLessThanOrEqual(limit.max);
      expect(limit.step).toBeGreaterThan(0);
    }
    expect(ORBIT_TEXT_SCALE_DEFAULT).toBeGreaterThanOrEqual(ORBIT_TEXT_SCALE_MIN);
    expect(ORBIT_TEXT_SCALE_DEFAULT).toBeLessThanOrEqual(ORBIT_TEXT_SCALE_MAX);
  });

  it("clamps a setting into its range and falls back on a non-finite value", () => {
    expect(clampOrbitSetting("flowGlow", 9)).toBe(ORBIT_SETTING_LIMITS.flowGlow.max);
    expect(clampOrbitSetting("starBrightness", 0)).toBe(ORBIT_SETTING_LIMITS.starBrightness.min);
    expect(clampOrbitSetting("spring", Number.NaN)).toBe(ORBIT_SETTINGS_DEFAULT.spring);
    expect(clampOrbitSetting("revolutionSpeed", 0)).toBe(0);
  });

  it("clamps the text scale into its own range", () => {
    expect(clampOrbitTextScale(0.1)).toBe(ORBIT_TEXT_SCALE_MIN);
    expect(clampOrbitTextScale(9)).toBe(ORBIT_TEXT_SCALE_MAX);
    expect(clampOrbitTextScale(Number.POSITIVE_INFINITY)).toBe(ORBIT_TEXT_SCALE_DEFAULT);
  });
});
