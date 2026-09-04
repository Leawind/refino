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

  it("places a joiner between the rows of its grounds", () => {
    const engine = new IncrementalLayout();
    const grown = engine.sync(
      [
        constraint("G1A2B3C4"),
        constraint("G2A2B3C4"),
        constraint("J1A2B3C4", ["G1A2B3C4"]),
        constraint("J2A2B3C4", ["G2A2B3C4"]),
        constraint("M1N2O3P4", ["J1A2B3C4", "J2A2B3C4"]),
      ],
      "LR",
    );
    const y = (id: string) => byId(grown, id).y;
    const low = Math.min(y("J1A2B3C4"), y("J2A2B3C4"));
    const high = Math.max(y("J1A2B3C4"), y("J2A2B3C4"));
    // Integer rows cannot hit the exact midpoint; the joiner must stay
    // within half a slot of it.
    const pitch = high - low;
    expect(Math.abs(y("M1N2O3P4") - (low + high) / 2)).toBeLessThanOrEqual(pitch / 2);
  });

  it("spreads several children symmetrically around their ground's row", () => {
    const engine = new IncrementalLayout();
    const ids = ["D1A2B3C4", "D2A2B3C4", "D3A2B3C4", "D4A2B3C4"];
    const grown = engine.sync(
      [constraint("G1A2B3C4"), ...ids.map((id) => constraint(id, ["G1A2B3C4"]))],
      "LR",
    );
    const parentY = byId(grown, "G1A2B3C4").y;
    const rows = ids.map((id) => byId(grown, id).y).sort((a, b) => a - b);
    expect(new Set(rows).size).toBe(4);
    // Adjacent rows are one slot apart and the family straddles the ground's
    // row (README: 相邻层中点大致对齐，围绕锚点对称展开).
    const pitch = rows[1]! - rows[0]!;
    for (let i = 2; i < rows.length; i++) {
      expect(rows[i]! - rows[i - 1]!).toBe(pitch);
    }
    expect(parentY - rows[0]!).toBeLessThanOrEqual(2 * pitch);
    expect(rows[rows.length - 1]! - parentY).toBeLessThanOrEqual(2 * pitch);
    const midpoint = (rows[0]! + rows[rows.length - 1]!) / 2;
    expect(Math.abs(midpoint - parentY)).toBeLessThanOrEqual(pitch / 2);
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
    // LR: layers grow along x; TB: layers grow along y. A single-child chain
    // centers on its ground's row, so the TB chain is a straight line.
    expect(byId(lr, C2).x).toBeGreaterThan(byId(lr, C1).x);
    expect(byId(tb, C2).y).toBeGreaterThan(byId(tb, C1).y);
    expect(byId(tb, C1).x).toBe(byId(tb, P1).x);
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

describe("satellites", () => {
  const instance = (id: string, beside: string): LayoutNode => ({ id, beside });

  it("places a satellite one layer before its anchor, in its row", () => {
    const engine = new IncrementalLayout();
    const input = [premise(P1), constraint(C1, [P1]), instance(`S1@${C1}`, C1)];
    const grown = engine.sync(input, "LR");
    // One layer before the anchor — the same layer P1 sits in — one row
    // away from P1, which occupies the anchor's row in that layer.
    expect(byId(grown, `S1@${C1}`).x).toBe(byId(grown, P1).x);
    expect(byId(grown, `S1@${C1}`).x).toBeLessThan(byId(grown, C1).x);
    expect(byId(grown, `S1@${C1}`).y).not.toBe(byId(grown, P1).y);
  });

  it("keeps a satellite off a placed node occupying the anchor's row", () => {
    const engine = new IncrementalLayout();
    // P1 itself occupies the row before C1: the satellite shifts aside
    // instead of overlapping it.
    const grown = engine.sync(
      [premise(P1), constraint(C1, [P1]), instance(`S1@${C1}`, C1)],
      "LR",
    );
    expect(byId(grown, `S1@${C1}`).y).not.toBe(byId(grown, P1).y);
    const pitch = Math.abs(byId(grown, `S1@${C1}`).y - byId(grown, P1).y);
    expect(pitch).toBeLessThanOrEqual(2 * (44 + 32));
  });

  it("gives two satellites of one anchor distinct rows", () => {
    const engine = new IncrementalLayout();
    const grown = engine.sync(
      [
        premise(P1),
        premise(P2),
        constraint(C1, [P1, P2]),
        instance(`S1@${C1}`, C1),
        instance(`S2@${C1}`, C1),
      ],
      "LR",
    );
    expect(byId(grown, `S1@${C1}`).y).not.toBe(byId(grown, `S2@${C1}`).y);
  });

  it("restores a satellite's position after it leaves and returns", () => {
    const engine = new IncrementalLayout();
    const full = [premise(P1), constraint(C1, [P1]), instance(`S1@${C1}`, C1)];
    const original = byId(engine.sync(full, "LR"), `S1@${C1}`);
    engine.sync([premise(P1), constraint(C1, [P1])], "LR");
    expect(byId(engine.sync(full, "LR"), `S1@${C1}`)).toEqual(original);
  });
});
