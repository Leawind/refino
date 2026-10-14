import type { Camera, CameraBox, Viewport } from "./camera";

/**
 * Pure projection math for the canvas minimap (ui DESIGN.md, "视口"): the
 * map shows every working-set node and the visible viewport rectangle,
 * scaled to fit a fixed map rectangle. Extracted from the component so the
 * math is testable without WebGL.
 */

/** A node rectangle as the overview sees it (the renderer's scene entries,
 * minus display-only nodes). */
export interface OverviewNode {
  x: number;
  y: number;
  width: number;
  height: number;
  premise: boolean;
}

/** One overview snapshot from the renderer: node rects in virtual space,
 * the current camera and the on-screen viewport size. */
export interface OverviewSnapshot {
  nodes: OverviewNode[];
  camera: Camera;
  viewport: Viewport;
}

/** The virtual rectangle currently visible through the viewport. */
export function visibleRect(snapshot: Pick<OverviewSnapshot, "camera" | "viewport">): CameraBox {
  const { camera, viewport } = snapshot;
  const minX = -camera.tx / camera.scale;
  const minY = -camera.ty / camera.scale;
  return {
    minX,
    minY,
    maxX: minX + viewport.width / camera.scale,
    maxY: minY + viewport.height / camera.scale,
  };
}

/** Union bounding box of the given rects; null when empty. */
export function unionRects(rects: readonly CameraBox[]): CameraBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.minX);
    minY = Math.min(minY, rect.minY);
    maxX = Math.max(maxX, rect.maxX);
    maxY = Math.max(maxY, rect.maxY);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** Map-space projection: virtual points scale by `scale` and land at
 * `offset`, centering the content box (nodes ∪ visible rect) in the map. */
export interface OverviewProjection {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export function fitProjection(
  content: CameraBox,
  size: { width: number; height: number },
  padding: number,
): OverviewProjection {
  const width = Math.max(1, content.maxX - content.minX);
  const height = Math.max(1, content.maxY - content.minY);
  const scale = Math.min((size.width - padding * 2) / width, (size.height - padding * 2) / height);
  return {
    scale,
    offsetX: (size.width - width * scale) / 2 - content.minX * scale,
    offsetY: (size.height - height * scale) / 2 - content.minY * scale,
  };
}

/** Virtual point → map-local px. */
export function toMap(
  projection: OverviewProjection,
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: x * projection.scale + projection.offsetX,
    y: y * projection.scale + projection.offsetY,
  };
}

/** Map-local px → virtual point (minimap click-to-navigate). */
export function toVirtual(
  projection: OverviewProjection,
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: (x - projection.offsetX) / projection.scale,
    y: (y - projection.offsetY) / projection.scale,
  };
}
