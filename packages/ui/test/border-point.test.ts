import { describe, expect, it } from "vitest";
import { borderPoint } from "../src/graph/render/renderer";
import { quantizeRasterScale } from "../src/graph/render/atlas";

/**
 * Geometry checks for the edge-trimming point: it must sit exactly on the
 * rounded-rect outline (the same SDF the node shader draws), on the ray
 * from the node center towards the target, and in front of the center.
 * Capsules (premise cards, radius = half height) are the case that used to
 * truncate on the sharp-cornered boundary.
 */

/** Rounded-rect signed distance, mirroring the node fragment shader. */
function sdRoundBox(px: number, py: number, hw: number, hh: number, r: number): number {
  const radius = Math.min(r, hw, hh);
  const qx = Math.abs(px) - hw + radius;
  const qy = Math.abs(py) - hh + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

function expectOnRoundedOutline(
  cx: number,
  cy: number,
  tx: number,
  ty: number,
  hw: number,
  hh: number,
  r: number,
): void {
  const [px, py] = borderPoint(cx, cy, tx, ty, hw, hh, r);
  const distance = sdRoundBox(px - cx, py - cy, hw, hh, r);
  expect(Math.abs(distance)).toBeLessThan(1e-6);
  // On the ray, in front of the center, not past the target pull point.
  const dx = tx - cx;
  const dy = ty - cy;
  const cross = (px - cx) * dy - (py - cy) * dx;
  expect(Math.abs(cross)).toBeLessThan(1e-6 * Math.max(1, Math.hypot(dx, dy)));
  expect((px - cx) * dx + (py - cy) * dy).toBeGreaterThanOrEqual(-1e-9);
}

describe("borderPoint", () => {
  it("keeps the sharp-cornered formula when the radius is zero", () => {
    // Straight right: the point is exactly on the right edge.
    expect(borderPoint(0, 0, 100, 0, 50, 20, 0)).toEqual([50, 0]);
    // Diagonal: exits through the top-right corner of the rect.
    const [x, y] = borderPoint(0, 0, 100, 40, 50, 20, 0);
    expect(x).toBeCloseTo(50, 9);
    expect(y).toBeCloseTo(20, 9);
  });

  it("returns the center for a degenerate segment", () => {
    expect(borderPoint(5, 7, 5, 7, 50, 20, 8)).toEqual([5, 7]);
  });

  it("hits straight edge midsections head-on", () => {
    expectOnRoundedOutline(0, 0, 100, 0, 50, 20, 8);
    expectOnRoundedOutline(0, 0, -100, 0, 50, 20, 8);
    expectOnRoundedOutline(0, 0, 0, 100, 50, 20, 8);
    const [x, y] = borderPoint(0, 0, 0, 100, 50, 20, 8);
    expect(x).toBe(0);
    expect(y).toBeCloseTo(20, 9);
  });

  it("hugs the rounded corners of an ordinary card", () => {
    for (const angle of [20, 35, 45, 55, 70, 110, 145, 200, 290, 335]) {
      const rad = (angle * Math.PI) / 180;
      expectOnRoundedOutline(0, 0, 300 * Math.cos(rad), 300 * Math.sin(rad), 75, 22, 8);
    }
  });

  it("trims capsules on their round halves, not on an imaginary rect", () => {
    // Premise cards draw as capsules: radius = half the height.
    for (const angle of [0, 10, 20, 30, 45, 60, 80, 100, 150, 170, 180, 210, 270, 330]) {
      const rad = (angle * Math.PI) / 180;
      expectOnRoundedOutline(0, 0, 300 * Math.cos(rad), 300 * Math.sin(rad), 60, 16, 16);
    }
    // Steep capsule directions must land on the arc, closer than the
    // sharp-cornered rect: the old formula put them at the rect corner.
    const [x, y] = borderPoint(0, 0, 30, 300, 60, 16, 16);
    expect(Math.hypot(x - 0, y - 0)).toBeLessThan(16 + 1e-6 + Math.hypot(60 - 0, 16));
  });

  it("survives random shapes and directions on the outline", () => {
    // Deterministic pseudo-random sweep.
    let seed = 42;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 300; i++) {
      const hw = 10 + next() * 90;
      const hh = 8 + next() * 60;
      const r = next() * Math.min(hw, hh);
      const angle = next() * Math.PI * 2;
      expectOnRoundedOutline(0, 0, 500 * Math.cos(angle), 500 * Math.sin(angle), hw, hh, r);
    }
  });
});

describe("quantizeRasterScale", () => {
  it("keeps tier 1 for near-1:1 zooms and steps up as zoom grows", () => {
    expect(quantizeRasterScale(1)).toBe(1);
    expect(quantizeRasterScale(1.2)).toBe(1);
    expect(quantizeRasterScale(1.3)).toBe(1.5);
    expect(quantizeRasterScale(2)).toBe(2.25);
    expect(quantizeRasterScale(5)).toBe(5);
    expect(quantizeRasterScale(12)).toBe(5);
  });
});
