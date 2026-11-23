import { describe, expect, it } from "vitest";
import {
  easeBlend,
  fitDistance,
  fovForLimiting,
  glideCenter,
  limitingFov,
  logGlowScale,
  MAX_FOV,
  MIN_FOV,
  pinchDistance,
  scaleAtDistance,
  uprightUp,
  wheelFov,
  wheelTargetDistance,
  zoomDistance,
} from "../src/graph/orbit/camera";

/** Orbit camera math (ui DESIGN.md, "三维视图"): one fitted distance drives
 * both the initial framing and the zoom readout. */

describe("orbit camera", () => {
  it("grows the fit distance with the content radius", () => {
    const small = fitDistance(5, 45, 1);
    const large = fitDistance(10, 45, 1);
    expect(small).toBeGreaterThan(5);
    expect(large).toBeCloseTo(small * 2, 6);
  });

  it("leaves room for a wide viewport", () => {
    expect(fitDistance(5, 45, 3)).toBeLessThan(fitDistance(5, 45, 0.5));
  });

  it("reads 100% at the fitted distance and larger when closer", () => {
    expect(scaleAtDistance(12, 12)).toBeCloseTo(1, 6);
    expect(scaleAtDistance(12, 6)).toBeCloseTo(2, 6);
    expect(scaleAtDistance(12, 24)).toBeCloseTo(0.5, 6);
    expect(scaleAtDistance(12, 0)).toBe(1);
  });

  it("turns a wheel notch into a coarse but continuous distance change", () => {
    // A 100px notch is roughly a quarter closer, in the direction of the
    // wheel: negative delta moves the camera in.
    expect(wheelTargetDistance(20, -100, 2.5, 100)).toBeCloseTo(20 * Math.exp(-0.22), 6);
    expect(wheelTargetDistance(20, -100, 2.5, 100)).toBeLessThan(20);
    expect(wheelTargetDistance(20, 100, 2.5, 100)).toBeGreaterThan(20);
    expect(wheelTargetDistance(20, -100, 2.5, 100)).toBeGreaterThan(15);
    expect(wheelTargetDistance(3, -100, 2.5, 100)).toBe(2.5);
    expect(wheelTargetDistance(90, 100, 2.5, 100)).toBe(100);
  });

  it("dollies multiplicatively inside the limits", () => {
    expect(zoomDistance(10, 2, 3, 100)).toBeCloseTo(5, 6);
    expect(zoomDistance(10, 0.5, 3, 100)).toBeCloseTo(20, 6);
    expect(zoomDistance(4, 2, 3, 100)).toBe(3);
    expect(zoomDistance(4, 0.5, 3, 100)).toBe(8);
    expect(zoomDistance(10, 0, 3, 100)).toBe(10);
  });

  it("eases by frame time with one time constant", () => {
    expect(easeBlend(0, 100)).toBe(0);
    expect(easeBlend(100, 100)).toBeCloseTo(1 - Math.exp(-1), 6);
    expect(easeBlend(16, 100)).toBeGreaterThan(0);
    expect(easeBlend(16, 100)).toBeLessThan(1);
    // Longer frames cover more ground; a slower time constant covers less.
    expect(easeBlend(33, 100)).toBeGreaterThan(easeBlend(16, 100));
    expect(easeBlend(16, 200)).toBeLessThan(easeBlend(16, 100));
  });

  it("glides the orbit center towards the focused star", () => {
    const target = { x: 0, y: 0, z: 0 };
    const camera = { x: 10, y: 0, z: 0 };
    const moving = glideCenter(target, camera, { x: 20, y: 0, z: 0 }, 0.25);
    expect(moving).toBe(true);
    expect(target.x).toBeCloseTo(5, 6);
    // The camera carries the same offset, so the view distance is untouched.
    expect(camera.x).toBeCloseTo(15, 6);
    expect(camera.x - target.x).toBeCloseTo(10, 6);
    expect(glideCenter(target, camera, { x: 20, y: 0, z: 0 }, 1)).toBe(true);
    expect(target).toEqual({ x: 20, y: 0, z: 0 });
    expect(camera.x - target.x).toBeCloseTo(10, 6);
  });

  it("ends a glide once it reaches the goal", () => {
    const target = { x: 1, y: 2, z: 0 };
    const camera = { x: 1, y: 2, z: 10 };
    expect(glideCenter(target, camera, { x: 1, y: 2, z: 0 }, 0.5)).toBe(false);
    expect(target).toEqual({ x: 1, y: 2, z: 0 });
    expect(camera).toEqual({ x: 1, y: 2, z: 10 });
  });

  it("grows a glow logarithmically as the camera approaches", () => {
    expect(logGlowScale(1)).toBeCloseTo(1, 6);
    // Doubling the zoom doubles neither the world scale nor the screen size:
    // the screen size grows by the logarithmic factor only.
    const doubleWorld = logGlowScale(2);
    const doubleScreen = doubleWorld * 2;
    expect(doubleWorld).toBeLessThan(1);
    expect(doubleScreen).toBeGreaterThan(1);
    expect(doubleScreen).toBeLessThan(2);
    const quadScreen = logGlowScale(4) * 4;
    expect(quadScreen).toBeGreaterThan(doubleScreen);
    expect(quadScreen).toBeLessThan(4);
    // Extreme zooming out stays finite and positive.
    expect(logGlowScale(0)).toBeGreaterThan(0);
  });

  it("turns a Ctrl+wheel notch into a coarse field-of-view change", () => {
    expect(wheelFov(60, -100)).toBeCloseTo(60 * Math.exp(-0.22), 6);
    expect(wheelFov(60, -100)).toBeLessThan(60);
    expect(wheelFov(60, 100)).toBeGreaterThan(60);
    // The limits apply to the narrower viewing angle.
    expect(wheelFov(45, -100)).toBe(MIN_FOV);
    expect(wheelFov(MIN_FOV, -100)).toBe(MIN_FOV);
    expect(wheelFov(MAX_FOV, 100)).toBe(MAX_FOV);
  });

  it("measures the limits on the narrower viewing angle", () => {
    // A landscape viewport is limited by the vertical angle, unchanged.
    expect(limitingFov(60, 2)).toBeCloseTo(60, 6);
    expect(fovForLimiting(60, 2)).toBeCloseTo(60, 6);
    // A portrait viewport is limited by the horizontal angle instead.
    const horizontal = limitingFov(60, 0.5);
    expect(horizontal).toBeLessThan(60);
    expect((2 * Math.atan(Math.tan((60 * Math.PI) / 360) * 0.5) * 180) / Math.PI).toBeCloseTo(
      horizontal,
      6,
    );
    expect(limitingFov(fovForLimiting(60, 0.5), 0.5)).toBeCloseTo(60, 6);
    // The orbit limits bracket the narrower angle in both orientations.
    for (const aspect of [0.5, 1, 2]) {
      expect(limitingFov(fovForLimiting(MIN_FOV, aspect), aspect)).toBeCloseTo(MIN_FOV, 6);
      expect(limitingFov(fovForLimiting(MAX_FOV, aspect), aspect)).toBeCloseTo(MAX_FOV, 6);
    }
  });

  it("drops the roll of a trackball view when it looks from a distance", () => {
    const upright = uprightUp({ x: 0.55, y: 0.42, z: 1 });
    expect(upright).not.toBeNull();
    const up = upright!;
    // Square to the view, unit length, and pointing as far up as it can.
    expect(up.x * 0.55 + up.y * 0.42 + up.z * 1).toBeCloseTo(0, 6);
    expect(Math.hypot(up.x, up.y, up.z)).toBeCloseTo(1, 6);
    expect(up.y).toBeGreaterThan(0.5);
    // A side-on view keeps the plain world up.
    const side = uprightUp({ x: 1, y: 0, z: 0 })!;
    expect(side.y).toBeCloseTo(1, 6);
    expect(Math.abs(side.x)).toBeCloseTo(0, 6);
    expect(Math.abs(side.z)).toBeCloseTo(0, 6);
  });

  it("pinches the camera distance with the finger spread", () => {
    // Spreading the fingers halves the distance, pinching them doubles it.
    expect(pinchDistance(20, 100, 200, 2.5, 4000)).toBeCloseTo(10, 6);
    expect(pinchDistance(20, 200, 100, 2.5, 4000)).toBeCloseTo(40, 6);
    // The zoom limits still hold, and a degenerate gesture changes nothing.
    expect(pinchDistance(20, 100, 1000, 2.5, 4000)).toBe(2.5);
    expect(pinchDistance(200, 100, 1, 2.5, 4000)).toBe(4000);
    expect(pinchDistance(20, 0, 100, 2.5, 4000)).toBe(20);
    expect(pinchDistance(20, 100, 100, 2.5, 4000)).toBe(20);
  });

  it("keeps the roll when the view looks along the up axis", () => {
    // Every up axis is equally upright when looking straight up or down, and
    // within a degree of the axis the projection is numerical noise.
    expect(uprightUp({ x: 0, y: 1, z: 0 })).toBeNull();
    expect(uprightUp({ x: 0, y: -1, z: 0 })).toBeNull();
    expect(uprightUp({ x: 0.002, y: 1, z: 0 })).toBeNull();
    expect(uprightUp({ x: 0, y: 0, z: 0 })).toBeNull();
  });
});
