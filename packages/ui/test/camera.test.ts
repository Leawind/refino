import { describe, expect, it } from "vitest";
import {
  clampCamera,
  clampScale,
  fitCamera,
  minScale,
  pannedCamera,
  zoomedCamera,
  type CameraBox,
} from "../src/graph/render/camera";

/** A bbox wider than tall, like a typical layered working set. */
const box: CameraBox = { minX: 0, minY: 0, maxX: 900, maxY: 260 };
const viewport = { width: 768, height: 672 };

const intersectsViewport = (camera: { scale: number; tx: number; ty: number }): boolean => {
  const x0 = box.minX * camera.scale + camera.tx;
  const x1 = box.maxX * camera.scale + camera.tx;
  const y0 = box.minY * camera.scale + camera.ty;
  const y1 = box.maxY * camera.scale + camera.ty;
  return x0 <= viewport.width && x1 >= 0 && y0 <= viewport.height && y1 >= 0;
};

describe("zoom limits", () => {
  it("derives the minimum zoom from the bbox long side vs half the viewport short side", () => {
    expect(minScale(box, viewport)).toBeCloseTo(672 / 2 / 900, 6);
  });

  it("clamps scale into [minScale, maxScale], the floor winning over the cap", () => {
    expect(clampScale(0.01, box, viewport, 4)).toBeCloseTo(672 / 2 / 900, 6);
    expect(clampScale(100, box, viewport, 4)).toBe(4);
    expect(clampScale(1.5, box, viewport, 4)).toBe(1.5);
    // A degenerate single-node bbox forces a high floor that beats the cap.
    const tiny: CameraBox = { minX: 0, minY: 0, maxX: 150, maxY: 44 };
    expect(clampScale(1, tiny, viewport, 4)).toBeCloseTo(336 / 150, 6);
  });
});

describe("pan clamping", () => {
  it("keeps the bbox intersecting the viewport at every clamp", () => {
    for (const tx of [-5000, -100, 0, 400, 5000]) {
      for (const ty of [-5000, -50, 0, 300, 5000]) {
        const camera = clampCamera({ scale: 0.8, tx, ty }, box, viewport);
        expect(intersectsViewport(camera)).toBe(true);
      }
    }
  });

  it("lets a camera that already complies through unchanged", () => {
    const camera = { scale: 0.8, tx: 24, ty: 117 };
    expect(clampCamera(camera, box, viewport)).toEqual(camera);
  });

  it("clamps scale while panning a too-far zoomed-out camera", () => {
    const camera = clampCamera({ scale: 0.001, tx: 0, ty: 0 }, box, viewport);
    expect(camera.scale).toBeCloseTo(672 / 2 / 900, 6);
  });
});

describe("fit camera", () => {
  it("fits the whole bbox inside the margins and respects the cap", () => {
    const camera = fitCamera(box, viewport, 4, 24);
    const right = box.maxX * camera.scale + camera.tx;
    const bottom = box.maxY * camera.scale + camera.ty;
    expect(camera.scale).toBeCloseTo((768 - 48) / 900, 6);
    expect(right).toBeCloseTo(viewport.width - 24, 1);
    expect(bottom).toBeLessThan(viewport.height);

    // Long side ≥ 168 keeps the floor below the cap, so the cap applies.
    const capped = fitCamera({ minX: 0, minY: 0, maxX: 350, maxY: 300 }, viewport, 2, 24);
    expect(capped.scale).toBe(2);
    // A degenerate tiny bbox raises the floor above the cap; the floor wins.
    const tiny = fitCamera({ minX: 0, minY: 0, maxX: 150, maxY: 44 }, viewport, 2, 24);
    expect(tiny.scale).toBeCloseTo(336 / 150, 6);
  });
});

describe("zooming", () => {
  it("keeps the virtual point under the anchor fixed", () => {
    const camera = { scale: 0.8, tx: 24, ty: 117 };
    const anchor = { x: 500, y: 300 };
    const zoomed = zoomedCamera(camera, 1.6, anchor, viewport, box, 4);
    const beforeX = (anchor.x - camera.tx) / camera.scale;
    const beforeY = (anchor.y - camera.ty) / camera.scale;
    expect((anchor.x - zoomed.tx) / zoomed.scale).toBeCloseTo(beforeX, 6);
    expect((anchor.y - zoomed.ty) / zoomed.scale).toBeCloseTo(beforeY, 6);
  });

  it("zooms around the viewport center when the anchor is null", () => {
    const camera = { scale: 0.8, tx: 24, ty: 117 };
    const zoomed = zoomedCamera(camera, 2, null, viewport, box, 4);
    const cx = viewport.width / 2;
    const cy = viewport.height / 2;
    expect((cx - zoomed.tx) / zoomed.scale).toBeCloseTo((cx - camera.tx) / camera.scale, 6);
    expect((cy - zoomed.ty) / zoomed.scale).toBeCloseTo((cy - camera.ty) / camera.scale, 6);
  });

  it("respects the maximum zoom cap", () => {
    const camera = { scale: 3.9, tx: 0, ty: 0 };
    const zoomed = zoomedCamera(camera, 2, null, viewport, box, 4);
    expect(zoomed.scale).toBe(4);
  });
});

describe("panning", () => {
  it("moves the camera by the screen delta, clamped", () => {
    const camera = { scale: 0.8, tx: 24, ty: 117 };
    const moved = pannedCamera(camera, 30, -50, viewport, box);
    expect(moved.tx).toBe(54);
    expect(moved.ty).toBe(67);
    const far = pannedCamera(moved, 100000, 100000, viewport, box);
    expect(intersectsViewport(far)).toBe(true);
  });
});
