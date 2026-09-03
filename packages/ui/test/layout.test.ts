import { describe, expect, it } from "vitest";
import { IncrementalLayout } from "../src/graph/layout/engine";
import type { LayoutNode } from "../src/graph/layout/engine";

/**
 * Incremental layered layout (ui README, "布局：增量分层"): stable virtual
 * coordinates, attachment relative to placed neighbors, independent
 * components, deterministic results and the direction mapping.
 */

const P1 = "1A2B3C4D";
const P2 = "1A2B3C4E";
const C1 = "A1B2C3D4";
const C2 = "D4E5F6G7";
const C3 = "E5F6G7H8";

const constraint = (id: string, grounds: string[]): LayoutNode => ({ id, grounds });
const premise = (id: string): LayoutNode => ({ id });

const byId = (nodes: ReturnType<IncrementalLayout["sync"]>, id: string) => {
  const node = nodes.find((n) => n.id === id);
  if (node === undefined) throw new Error(`${id} not laid out`);
  return node;
};

describe("layer assignment", () => {
  it("sits new nodes one layer below their deepest placed ground", () => {
    const engine = new IncrementalLayout();
    engine.sync([premise(P1), constraint(C1, [P1])], "LR");
    const grown = engine.sync(
      [premise(P1), constraint(C1, [P1]), constraint(C2, [C1]), constraint(C3, [C1, C2])],
      "LR",
    );
    expect(byId(grown, C2).x).toBeGreaterThan(byId(grown, C1).x);
    expect(byId(grown, C3).x).toBeGreaterThan(byId(grown, C2).x);
  });

  it("pulls a new predecessor in one layer above its placed dependent", () => {
    const engine = new IncrementalLayout();
    // C2 enters while its ground C1 is absent: a source of its own component.
    engine.sync([constraint(C2, [C1])], "LR");
    // C1 arrives later as a ground of the placed C2.
    const grown = engine.sync([constraint(C1, [P1]), constraint(C2, [C1])], "LR");
    expect(byId(grown, C1).x).toBeLessThan(byId(grown, C2).x);
  });

  it("spreads siblings of one ground over distinct orders", () => {
    const engine = new IncrementalLayout();
    engine.sync([premise(P1)], "LR");
    const grown = engine.sync(
      [premise(P1), constraint(C1, [P1]), constraint(C2, [P1]), constraint(C3, [P1])],
      "LR",
    );
    const ys = [C1, C2, C3].map((id) => byId(grown, id).y);
    expect(new Set(ys).size).toBe(3);
  });
});

describe("coordinate stability", () => {
  it("never moves placed nodes while the working set grows", () => {
    const engine = new IncrementalLayout();
    const first = engine.sync([premise(P1), constraint(C1, [P1])], "LR");
    const grown = engine.sync(
      [
        premise(P1),
        premise(P2),
        constraint(C1, [P1]),
        constraint(C2, [C1, P2]),
        constraint(C3, [C2]),
      ],
      "LR",
    );
    for (const before of first) {
      const after = byId(grown, before.id);
      expect({ x: after.x, y: after.y }).toEqual({ x: before.x, y: before.y });
    }
  });

  it("restores a node's position after it leaves and returns", () => {
    const engine = new IncrementalLayout();
    const full = [premise(P1), constraint(C1, [P1]), constraint(C2, [C1])];
    const original = engine.sync(full, "LR");
    const originalC2 = byId(original, C2);
    // C2 leaves (working set shrinks) and comes back.
    engine.sync([premise(P1), constraint(C1, [P1])], "LR");
    const restored = byId(engine.sync(full, "LR"), C2);
    expect(restored).toEqual(originalC2);
  });
});

describe("independent components", () => {
  it("places a disjoint addition below the existing content without overlap", () => {
    const engine = new IncrementalLayout();
    const first = engine.sync([premise(P1), constraint(C1, [P1])], "LR");
    const maxY = Math.max(...first.map((n) => n.y + n.height));
    const grown = engine.sync(
      [premise(P1), constraint(C1, [P1]), premise(P2), constraint(C2, [P2])],
      "LR",
    );
    const newNodes = [P2, C2].map((id) => byId(grown, id));
    for (const node of newNodes) {
      expect(node.y).toBeGreaterThan(maxY);
      expect(node.x).toBeGreaterThanOrEqual(0);
    }
    // The two components keep their internal chain: C2 sits right of P2.
    expect(byId(grown, C2).x).toBeGreaterThan(byId(grown, P2).x);
  });

  it("is deterministic across engine instances", () => {
    const input = [
      premise(P1),
      premise(P2),
      constraint(C1, [P1]),
      constraint(C2, [C1, P2]),
      constraint(C3, [C2]),
    ];
    const positions = ((): string[] => {
      const engine = new IncrementalLayout();
      engine.sync(input.slice(0, 2), "LR");
      return engine.sync(input, "LR").map((n) => `${n.id}@${n.x},${n.y}`);
    })();
    const again = ((): string[] => {
      const engine = new IncrementalLayout();
      engine.sync(input.slice(0, 2), "LR");
      return engine.sync(input, "LR").map((n) => `${n.id}@${n.x},${n.y}`);
    })();
    expect(positions).toEqual(again);
  });
});

describe("direction mapping", () => {
  it("remaps axes without disturbing canonical placements", () => {
    const engine = new IncrementalLayout();
    const lr = engine.sync([premise(P1), constraint(C1, [P1]), constraint(C2, [C1])], "LR");
    const tb = engine.sync([premise(P1), constraint(C1, [P1]), constraint(C2, [C1])], "TB");
    // LR: layers grow along x; TB: layers grow along y.
    expect(byId(lr, C2).x).toBeGreaterThan(byId(lr, C1).x);
    expect(byId(tb, C2).y).toBeGreaterThan(byId(tb, C1).y);
    expect(byId(tb, C1).x).toBeGreaterThan(byId(tb, P1).x);
    // Switching back restores the original coordinates exactly.
    expect(engine.sync([premise(P1), constraint(C1, [P1]), constraint(C2, [C1])], "LR")).toEqual(
      lr,
    );
  });

  it("mirrors RL and BT", () => {
    const engine = new IncrementalLayout();
    const lr = engine.sync([premise(P1), constraint(C1, [P1])], "LR");
    const rl = engine.sync([premise(P1), constraint(C1, [P1])], "RL");
    expect(byId(rl, C1).x).toBeLessThan(byId(rl, P1).x);
    expect(byId(rl, P1).y).toBe(byId(lr, P1).y);
    const bt = engine.sync([premise(P1), constraint(C1, [P1])], "BT");
    expect(byId(bt, C1).y).toBeLessThan(byId(bt, P1).y);
  });
});
