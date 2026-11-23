/**
 * Camera math for the orbit view (ui DESIGN.md, "三维视图"): the camera
 * circles a target at a fixed distance, so a wheel notch only changes that
 * distance. These helpers keep the fit and the zoom readout in one place.
 */

/** Distance at which a sphere of `radius` fills the viewport short side.
 * `margin` > 1 leaves breathing room around the content. */
export function fitDistance(radius: number, fovDeg: number, aspect: number, margin = 1.15): number {
  const vertical = (fovDeg * Math.PI) / 180;
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * Math.max(aspect, 0.01));
  const limiting = Math.min(vertical, horizontal);
  return (Math.max(radius, 0.01) / Math.sin(limiting / 2)) * margin;
}

/** Zoom readout: 100% at the fitted distance, larger when closer. */
export function scaleAtDistance(referenceDistance: number, distance: number): number {
  if (!Number.isFinite(distance) || distance <= 0) return 1;
  return referenceDistance / distance;
}

/** Multiplicative zoom step, i.e. one command from the zoom controls. */
export function zoomDistance(distance: number, factor: number, min: number, max: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return distance;
  return Math.min(max, Math.max(min, distance / factor));
}

/** Wheel sensitivity: a 100px notch multiplies the camera distance by
 * about 0.8, a deliberately coarse step. */
export const WHEEL_ZOOM_SENSITIVITY = 0.0022;

/** Camera distance after one wheel event, clamped to the zoom limits.
 * Negative delta (wheel up) moves closer. */
export function wheelTargetDistance(
  distance: number,
  deltaY: number,
  min: number,
  max: number,
): number {
  return Math.min(max, Math.max(min, distance * Math.exp(deltaY * WHEEL_ZOOM_SENSITIVITY)));
}

/** Field-of-view limits measured on the narrower viewing angle: whichever of
 * the horizontal and vertical angles is smaller decides how much of the scene
 * fits, so the limits belong to it rather than to the vertical one alone. */
export const MIN_FOV = 40;
export const MAX_FOV = 120;
/** Narrower viewing angle the orbit scene starts at and resets to. */
export const DEFAULT_FOV = 45;

const DEGREES = Math.PI / 180;

/** The narrower of the vertical and horizontal viewing angles, in degrees. */
export function limitingFov(fovDeg: number, aspect: number): number {
  const vertical = fovDeg * DEGREES;
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * Math.max(aspect, 0.01));
  return Math.min(vertical, horizontal) / DEGREES;
}

/** Vertical field of view whose narrower angle is `limitingDeg`. */
export function fovForLimiting(limitingDeg: number, aspect: number): number {
  const wide = Math.max(aspect, 0.01);
  if (wide >= 1) return limitingDeg;
  return (2 * Math.atan(Math.tan((limitingDeg * DEGREES) / 2) / wide)) / DEGREES;
}

/** Clamp a narrower viewing angle to the orbit limits. */
export function clampLimitingFov(fovDeg: number): number {
  return Math.min(MAX_FOV, Math.max(MIN_FOV, fovDeg));
}

/** Narrower viewing angle after one Ctrl+wheel event: the same coarse
 * multiplicative step as the distance wheel, clamped so the camera never
 * degenerates. */
export function wheelFov(fov: number, deltaY: number): number {
  return clampLimitingFov(fov * Math.exp(deltaY * WHEEL_ZOOM_SENSITIVITY));
}

/** Exponential approach factor for one frame of `delta` milliseconds: 0 at
 * rest and towards 1 with the time constant `tau`. Frame-rate independent,
 * so easing the camera and the halos looks the same at any refresh rate. */
export function easeBlend(delta: number, tau: number): number {
  if (!Number.isFinite(delta) || delta <= 0 || !(tau > 0)) return 0;
  return 1 - Math.exp(-delta / tau);
}

/** One frame of the orbit-center glide: the target and the camera move by the
 * same offset, so the camera keeps its distance and viewing direction while
 * the rotation center travels towards `goal`. Returns whether it is still
 * travelling; a step within rounding distance of the goal ends the glide. */
export function glideCenter(
  target: { x: number; y: number; z: number },
  camera: { x: number; y: number; z: number },
  goal: { x: number; y: number; z: number },
  blend: number,
): boolean {
  const dx = goal.x - target.x;
  const dy = goal.y - target.y;
  const dz = goal.z - target.z;
  if (Math.hypot(dx, dy, dz) < 0.02) return false;
  const step = Math.min(1, Math.max(0, blend));
  target.x += dx * step;
  target.y += dy * step;
  target.z += dz * step;
  camera.x += dx * step;
  camera.y += dy * step;
  camera.z += dz * step;
  return true;
}

/** World-scale multiplier that turns the perspective growth of a glow into a
 * logarithmic one. `zoom` is the reference distance over the current depth to
 * the glow; without compensation a world-wide halo would grow linearly with
 * it. The returned multiplier keeps the on-screen size growing roughly as
 * `1 + growth * ln(zoom)`, so close-ups do not blow the glow up. */
export function logGlowScale(zoom: number, growth = 0.7, min = 0.35, minZoom = 0.05): number {
  const q = Math.max(zoom, minZoom);
  const onScreen = Math.max(min, 1 + growth * Math.log(q));
  return onScreen / q;
}

/** Distance between two points. */
export function pointDistance(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

/** Camera distance after a pinch: the fingers' spread scales the distance
 * inversely, so spreading them zooms in. Clamped to the zoom limits. */
export function pinchDistance(
  distance: number,
  spread: number,
  nextSpread: number,
  min: number,
  max: number,
): number {
  if (!(spread > 0) || !(nextSpread > 0) || !Number.isFinite(distance)) return distance;
  return Math.min(max, Math.max(min, distance * (spread / nextSpread)));
}

/** Up axis without roll: the world up projected onto the plane square to the
 * viewing direction, so the view comes out upright after a trackball drag.
 * Null when the view looks along the world up axis, where every roll is
 * equally upright and the current one should stand. */
export function uprightUp(direction: {
  x: number;
  y: number;
  z: number;
}): { x: number; y: number; z: number } | null {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!(length > 0)) return null;
  const along = direction.y / length;
  const lengthSq = 1 - along * along;
  // Within about a degree of the axis the projection comes out numerically
  // meaningless; the caller keeps its roll instead.
  if (!(lengthSq > 1e-4)) return null;
  const scale = 1 / Math.sqrt(lengthSq);
  return {
    x: -along * (direction.x / length) * scale,
    y: lengthSq * scale,
    z: -along * (direction.z / length) * scale,
  };
}
