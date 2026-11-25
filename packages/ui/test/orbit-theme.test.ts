import { describe, expect, it } from "vitest";
import { ORBIT_PAPER_THEME, ORBIT_THEME, orbitThemeFor } from "../src/graph/orbit/theme";
import {
  clampRotateSensitivity,
  DEFAULT_ROTATE_SENSITIVITY,
  ROTATE_SENSITIVITY_MAX,
  ROTATE_SENSITIVITY_MIN,
} from "../src/graph/orbit/camera";

/**
 * The orbit palettes keep the three kinds of mark unambiguous — red virtual
 * root, blue decisions, premise satellites in the tone opposite to the page —
 * in both the deep-space and the paper chart. Rotation sensitivity is bounded
 * so a stray value cannot make the star map unusable.
 */
describe("orbit theme", () => {
  it("colors the root red and the decisions blue in both palettes", () => {
    for (const theme of [ORBIT_THEME, ORBIT_PAPER_THEME]) {
      const [red, green, blue] = theme.root;
      expect(red).toBeGreaterThan(0.7);
      expect(green).toBeLessThan(red / 2);
      expect(blue).toBeLessThan(red / 2);
      for (const star of [theme.star, theme.deepStar]) {
        expect(star[2]).toBeGreaterThan(star[0]);
        expect(star[2]).toBeGreaterThan(star[1]);
      }
    }
  });

  it("turns the premises into the tone opposite to the page", () => {
    // White reads on deep space; on paper the same role needs dark ink.
    expect(ORBIT_THEME.premise).toEqual([1, 1, 1, 1]);
    for (const channel of ORBIT_PAPER_THEME.premise.slice(0, 3)) {
      expect(channel).toBeLessThan(0.4);
    }
    const luma = (value: readonly number[]): number => value[0]! + value[1]! + value[2]!;
    expect(luma(ORBIT_THEME.background)).toBeLessThan(0.5);
    expect(luma(ORBIT_PAPER_THEME.background)).toBeGreaterThan(2.5);
  });

  it("maps each UI theme to its palette and its compositing mode", () => {
    expect(orbitThemeFor("dark")).toBe(ORBIT_THEME);
    expect(orbitThemeFor("light")).toBe(ORBIT_PAPER_THEME);
    expect(ORBIT_THEME.ink).toBe(false);
    expect(ORBIT_PAPER_THEME.ink).toBe(true);
    for (const theme of [ORBIT_THEME, ORBIT_PAPER_THEME]) {
      expect(theme.backgroundCss.startsWith("#")).toBe(true);
      expect(theme.opacity.star).toBeGreaterThan(0);
    }
  });
});

describe("clampRotateSensitivity", () => {
  it("keeps the default inside the adjustable range", () => {
    expect(clampRotateSensitivity(DEFAULT_ROTATE_SENSITIVITY)).toBe(DEFAULT_ROTATE_SENSITIVITY);
    expect(DEFAULT_ROTATE_SENSITIVITY).toBeGreaterThanOrEqual(ROTATE_SENSITIVITY_MIN);
    expect(DEFAULT_ROTATE_SENSITIVITY).toBeLessThanOrEqual(ROTATE_SENSITIVITY_MAX);
  });

  it("clamps out-of-range and non-finite values", () => {
    expect(clampRotateSensitivity(0)).toBe(ROTATE_SENSITIVITY_MIN);
    expect(clampRotateSensitivity(100)).toBe(ROTATE_SENSITIVITY_MAX);
    expect(clampRotateSensitivity(Number.NaN)).toBe(DEFAULT_ROTATE_SENSITIVITY);
  });
});
