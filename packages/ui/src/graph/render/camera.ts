/**
 * Camera math for the canvas viewport (ui README, "视口"). Pure functions:
 * the renderer owns the current/target camera pair and animates towards the
 * target, these helpers compute constraint-compliant targets.
 *
 * Screen position = virtual position × scale + translate. The bounding box
 * (union of all laid-out nodes) only constrains the viewport, it is never
 * rendered:
 *
 * - zoom: the bbox long side on screen must not shrink below the viewport
 *   short side (the minimum zoom); the maximum zoom is a configured cap;
 * - pan: the bbox must keep intersecting the viewport (it must never slide
 *   fully out of view).
 *
 * Targets are clamped when they are set, so the resting camera always
 * complies; the target-value smoothing turns every correction into a smooth
 * spring-back.
 */

export interface Camera {
  scale: number;
  tx: number;
  ty: number;
}

export interface CameraBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Viewport {
  width: number;
  height: number;
}

const SCALE_FLOOR = 0.02;

/** The minimum zoom: bbox long side on screen ≥ viewport short side. */
export function minScale(box: CameraBox, viewport: Viewport): number {
  const longSide = Math.max(box.maxX - box.minX, box.maxY - box.minY);
  if (longSide <= 0) return SCALE_FLOOR;
  const shortSide = Math.min(viewport.width, viewport.height);
  return Math.max(SCALE_FLOOR, shortSide / longSide);
}

export function clampScale(
  scale: number,
  box: CameraBox,
  viewport: Viewport,
  maxScale: number,
): number {
  const floor = minScale(box, viewport);
  // The floor is semantic (never lose the graph); the cap yields to it.
  return Math.max(floor, Math.min(maxScale, scale));
}

/** Pan bounds: the bbox must keep intersecting the viewport. */
export function clampCamera(camera: Camera, box: CameraBox, viewport: Viewport): Camera {
  const scale = clampScale(camera.scale, box, viewport, Number.POSITIVE_INFINITY);
  const tx = Math.min(viewport.width - box.minX * scale, Math.max(-box.maxX * scale, camera.tx));
  const ty = Math.min(viewport.height - box.minY * scale, Math.max(-box.maxY * scale, camera.ty));
  return { scale, tx, ty };
}

/** Camera that fits the whole bbox with a margin, clamped to the limits. */
export function fitCamera(
  box: CameraBox,
  viewport: Viewport,
  maxScale: number,
  margin: number,
): Camera {
  const width = Math.max(1, box.maxX - box.minX);
  const height = Math.max(1, box.maxY - box.minY);
  const scale = clampScale(
    Math.min(
      maxScale,
      (viewport.width - margin * 2) / width,
      (viewport.height - margin * 2) / height,
    ),
    box,
    viewport,
    maxScale,
  );
  return clampCamera(
    {
      scale,
      tx: (viewport.width - width * scale) / 2 - box.minX * scale,
      ty: (viewport.height - height * scale) / 2 - box.minY * scale,
    },
    box,
    viewport,
  );
}

/** Camera centered on a content point, keeping the current scale. */
export function centeredCamera(
  center: { x: number; y: number },
  viewport: Viewport,
  camera: Camera,
  box: CameraBox,
  maxScale: number,
): Camera {
  const scale = clampScale(camera.scale, box, viewport, maxScale);
  return clampCamera(
    {
      scale,
      tx: viewport.width / 2 - center.x * scale,
      ty: viewport.height / 2 - center.y * scale,
    },
    box,
    viewport,
  );
}

/** Zoom by a multiplicative factor around an anchor point (canvas-local px;
 * null = viewport center). The virtual point under the anchor stays there. */
export function zoomedCamera(
  camera: Camera,
  factor: number,
  anchor: { x: number; y: number } | null,
  viewport: Viewport,
  box: CameraBox,
  maxScale: number,
): Camera {
  const scale = clampScale(camera.scale * factor, box, viewport, maxScale);
  const ax = anchor?.x ?? viewport.width / 2;
  const ay = anchor?.y ?? viewport.height / 2;
  const ratio = scale / camera.scale;
  return clampCamera(
    { scale, tx: ax - (ax - camera.tx) * ratio, ty: ay - (ay - camera.ty) * ratio },
    box,
    viewport,
  );
}

/** Pan by a screen-space delta. */
export function pannedCamera(
  camera: Camera,
  dx: number,
  dy: number,
  viewport: Viewport,
  box: CameraBox,
): Camera {
  return clampCamera(
    { scale: camera.scale, tx: camera.tx + dx, ty: camera.ty + dy },
    box,
    viewport,
  );
}
