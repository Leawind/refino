import { describe, expect, it } from "vitest";
import { CROSS_GAP, NODE_HEIGHT, NODE_WIDTH } from "../src/graph/layout/engine";
import { railStrategy } from "../src/graph/layout/rail";
import type { LayoutNode } from "../src/graph/layout/types";

function chain(length: number): LayoutNode[] {
  return Array.from({ length }, (_, i) => ({
    id: `n${i}`,
    grounds: i === 0 ? [] : [`n${i - 1}`],
  }));
}

/** One ground with several direct dependents: a wide layer to relax. */
function fan(leaves: number): LayoutNode[] {
  return [
    { id: "root", grounds: [] },
    ...Array.from({ length: leaves }, (_, i) => ({ id: `leaf${i}`, grounds: ["root"] })),
  ];
}

function settled(nodes: LayoutNode[], direction: "LR" | "TB" = "LR") {
  const session = railStrategy.createSession(nodes, { direction });
  let positions = session.positions();
  for (let step = 0; step < 400 && session.animating; step++) {
    positions = session.step(16);
  }
  expect(session.animating).toBe(false);
  session.dispose();
  return positions;
}

describe("rail layout", () => {
  it("pins every node to its layer line on the main axis", () => {
    const laid = settled(chain(4), "LR");
    const byId = new Map(laid.map((n) => [n.id, n] as const));
    const pitch = NODE_WIDTH + 44;
    for (let i = 0; i < 4; i++) {
      expect(byId.get(`n${i}`)!.x).toBeCloseTo(i * pitch, 6);
    }
  });

  it("keeps layer mates separated along the cross axis", () => {
    const laid = settled(fan(4));
    const leaves = laid.filter((n) => n.id.startsWith("leaf")).sort((a, b) => a.y - b.y);
    expect(leaves.length).toBe(4);
    for (let i = 1; i < leaves.length; i++) {
      expect(leaves[i]!.y - leaves[i - 1]!.y).toBeGreaterThanOrEqual(NODE_HEIGHT + CROSS_GAP - 0.5);
    }
  });

  it("separates an overlapping seed deterministically", () => {
    // Two same-layer leaves seeded onto the exact same spot must separate;
    // determinism requires the same final geometry from equal runs.
    const seed = new Map(
      fan(4).map((n) => [n.id, { x: n.id === "root" ? 0 : NODE_WIDTH + 44, y: 100 }] as const),
    );
    const run = (): Map<string, { x: number; y: number }> => {
      const session = railStrategy.createSession(fan(4), { direction: "LR", seed });
      let positions = session.positions();
      for (let step = 0; step < 400 && session.animating; step++) positions = session.step(16);
      session.dispose();
      return new Map(positions.map((n) => [n.id, { x: n.x, y: n.y }] as const));
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b);
    const ys = [...a.entries()]
      .filter(([id]) => id !== "root")
      .map(([, p]) => p.y)
      .sort((p, q) => p - q);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(NODE_HEIGHT + CROSS_GAP - 0.5);
    }
  });

  it("drags slide along the rail only", () => {
    const session = railStrategy.createSession(chain(3), { direction: "LR" });
    for (let step = 0; step < 400 && session.animating; step++) session.step(16);
    const before = session.positions().find((n) => n.id === "n1")!;
    session.fix("n1", 9999, 555);
    for (let step = 0; step < 20; step++) session.step(16);
    const during = session.positions().find((n) => n.id === "n1")!;
    expect(during.x).toBeCloseTo(before.x, 6);
    expect(during.y).toBeCloseTo(555, 6);
    session.release("n1");
    for (let step = 0; step < 400 && session.animating; step++) session.step(16);
    const after = session.positions().find((n) => n.id === "n1")!;
    expect(after.x).toBeCloseTo(before.x, 6);
    session.dispose();
  });

  it("works in the vertical direction with the same invariants", () => {
    const laid = settled(chain(3), "TB");
    const byId = new Map(laid.map((n) => [n.id, n] as const));
    const pitch = NODE_HEIGHT + 44;
    for (let i = 0; i < 3; i++) {
      expect(byId.get(`n${i}`)!.y).toBeCloseTo(i * pitch, 6);
    }
  });
});
