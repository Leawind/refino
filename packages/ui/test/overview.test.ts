import { describe, expect, it } from "vitest";
import {
  fitProjection,
  toMap,
  toVirtual,
  unionRects,
  visibleRect,
  type OverviewSnapshot,
} from "../src/graph/render/overview";

/**
 * Pure projection math for the minimap (ui DESIGN.md, "视口"): the content
 * box (nodes ∪ viewport) centers in the map with padding, and map/virtual
 * coordinates round-trip.
 */

const snapshot: OverviewSnapshot = {
  nodes: [
    { x: 0, y: 0, width: 100, height: 40, premise: false },
    { x: 300, y: 200, width: 100, height: 40, premise: true },
  ],
  camera: { scale: 2, tx: -400, ty: -300 },
  viewport: { width: 800, height: 600 },
};

describe("overview projection", () => {
  it("derives the virtual rect the camera looks through", () => {
    const visible = visibleRect(snapshot);
    expect(visible).toEqual({ minX: 200, minY: 150, maxX: 600, maxY: 450 });
  });

  it("unions rects and returns null when empty", () => {
    expect(unionRects([])).toBeNull();
    const union = unionRects([
      { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      { minX: 5, minY: 20, maxX: 8, maxY: 30 },
    ]);
    expect(union).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 30 });
  });

  it("fits the content into the padded map without distortion", () => {
    const projection = fitProjection(
      { minX: 0, minY: 0, maxX: 400, maxY: 200 },
      { width: 220, height: 160 },
      10,
    );
    // Width binds: (220-20)/400 = 0.5 < (160-20)/200 = 0.7.
    expect(projection.scale).toBeCloseTo(0.5);
    const center = toMap(projection, 200, 100);
    expect(center.x).toBeCloseTo(110);
    expect(center.y).toBeCloseTo(80);
  });

  it("round-trips map coordinates back to virtual space", () => {
    const projection = fitProjection(
      { minX: -50, minY: -20, maxX: 350, maxY: 180 },
      { width: 200, height: 140 },
      8,
    );
    const point = toMap(projection, 123, -7);
    const back = toVirtual(projection, point.x, point.y);
    expect(back.x).toBeCloseTo(123);
    expect(back.y).toBeCloseTo(-7);
  });
});
