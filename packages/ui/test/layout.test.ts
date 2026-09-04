import { describe, expect, it } from "vitest";
import { layeredLayout } from "../src/graph/layout/engine";
import type { LayoutNode } from "../src/graph/layout/engine";

/**
 * Stateless layered layout (ui README, "布局"): the whole displayed subgraph
 * is laid out from scratch on every call — relative positions are a pure
 * function of the current structure. Covers layer assignment, family
 * centering, independent components, determinism and the direction mapping.
 */

const P1 = "1A2B3C4D";
const P2 = "1A2B3C4E";
const C1 = "A1B2C3D4";
const C2 = "D4E5F6G7";
const C3 = "E5F6G7H8";

const constraint = (id: string, grounds: string[]): LayoutNode => ({ id, grounds });
const premise = (id: string): LayoutNode => ({ id });

const byId = (nodes: ReturnType<typeof layeredLayout>, id: string) => {
  const node = nodes.find((n) => n.id === id);
  if (node === undefined) throw new Error(`${id} not laid out`);
  return node;
};

describe("layer assignment", () => {
  it("sits nodes one layer below their deepest ground", () => {
    const laid = layeredLayout(
      [premise(P1), constraint(C1, [P1]), constraint(C2, [C1]), constraint(C3, [C1, C2])],
      "LR",
    );
    expect(byId(laid, C1).x).toBeGreaterThan(byId(laid, P1).x);
    expect(byId(laid, C2).x).toBeGreaterThan(byId(laid, C1).x);
    expect(byId(laid, C3).x).toBeGreaterThan(byId(laid, C2).x);
  });

  it("spreads siblings of one ground over distinct rows", () => {
    const laid = layeredLayout(
      [premise(P1), constraint(C1, [P1]), constraint(C2, [P1]), constraint(C3, [P1])],
      "LR",
    );
    const ys = [C1, C2, C3].map((id) => byId(laid, id).y);
    expect(new Set(ys).size).toBe(3);
  });

  it("places a joiner between the rows of its grounds", () => {
    const laid = layeredLayout(
      [
        constraint("G1A2B3C4"),
        constraint("G2A2B3C4"),
        constraint("J1A2B3C4", ["G1A2B3C4"]),
        constraint("J2A2B3C4", ["G2A2B3C4"]),
        constraint("M1N2O3P4", ["J1A2B3C4", "J2A2B3C4"]),
      ],
      "LR",
    );
    const y = (id: string) => byId(laid, id).y;
    const low = Math.min(y("J1A2B3C4"), y("J2A2B3C4"));
    const high = Math.max(y("J1A2B3C4"), y("J2A2B3C4"));
    // Integer rows cannot hit the exact midpoint; the joiner must stay
    // within half a slot of it.
    const pitch = high - low;
    expect(Math.abs(y("M1N2O3P4") - (low + high) / 2)).toBeLessThanOrEqual(pitch / 2);
  });

  it("spreads several children symmetrically around their ground's row", () => {
    const ids = ["D1A2B3C4", "D2A2B3C4", "D3A2B3C4", "D4A2B3C4"];
    const laid = layeredLayout(
      [constraint("G1A2B3C4"), ...ids.map((id) => constraint(id, ["G1A2B3C4"]))],
      "LR",
    );
    const parentY = byId(laid, "G1A2B3C4").y;
    const rows = ids.map((id) => byId(laid, id).y).sort((a, b) => a - b);
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

describe("statelessness", () => {
  it("recomputes positions so they stay consistent with the current structure", () => {
    // A second ground entering changes the joiner's row: with one ground it
    // sits straight below it; with two it centers between their rows.
    const small = layeredLayout(
      [constraint("G1A2B3C4"), constraint("J1A2B3C4", ["G1A2B3C4"])],
      "LR",
    );
    const grown = layeredLayout(
      [
        constraint("G1A2B3C4"),
        constraint("G2A2B3C4"),
        constraint("J1A2B3C4", ["G1A2B3C4", "G2A2B3C4"]),
      ],
      "LR",
    );
    expect(byId(small, "J1A2B3C4").y).not.toBe(byId(grown, "J1A2B3C4").y);
    const rows = [byId(grown, "G1A2B3C4").y, byId(grown, "G2A2B3C4").y].sort((a, b) => a - b);
    const pitch = rows[1]! - rows[0]!;
    expect(Math.abs(byId(grown, "J1A2B3C4").y - (rows[0]! + rows[1]!) / 2)).toBeLessThanOrEqual(
      pitch / 2,
    );
  });

  it("is order-independent: the same set in any input order yields the same layout", () => {
    const input = [
      premise(P1),
      premise(P2),
      constraint(C1, [P1]),
      constraint(C2, [C1, P2]),
      constraint(C3, [C2]),
    ];
    const forward = layeredLayout(input, "LR");
    const shuffled = layeredLayout([input[3]!, input[0]!, input[4]!, input[2]!, input[1]!], "LR");
    expect(shuffled).toEqual(forward);
  });

  it("is deterministic across calls", () => {
    const input = [
      premise(P1),
      premise(P2),
      constraint(C1, [P1]),
      constraint(C2, [C1, P2]),
      constraint(C3, [C2]),
    ];
    expect(layeredLayout(input, "LR")).toEqual(layeredLayout(input, "LR"));
  });
});

describe("independent components", () => {
  it("places disjoint components in non-overlapping row ranges", () => {
    const laid = layeredLayout(
      [premise(P1), constraint(C1, [P1]), premise(P2), constraint(C2, [P2])],
      "LR",
    );
    const first = [P1, C1].map((id) => byId(laid, id));
    const second = [P2, C2].map((id) => byId(laid, id));
    const firstMax = Math.max(...first.map((n) => n.y + n.height));
    const secondMin = Math.min(...second.map((n) => n.y));
    expect(secondMin).toBeGreaterThanOrEqual(firstMax);
    // Each component keeps its internal chain: C1 right of P1, C2 of P2.
    expect(byId(laid, C1).x).toBeGreaterThan(byId(laid, P1).x);
    expect(byId(laid, C2).x).toBeGreaterThan(byId(laid, P2).x);
  });
});

describe("cyclic input", () => {
  // Cycles cannot layer strictly; the shared refino layering cuts back
  // edges deterministically so every node still gets finite coordinates.
  it("lays out every node of a cycle without NaN and deterministically", () => {
    const cyclic = [
      constraint(C1, [C3]),
      constraint(C2, [C1]),
      constraint(C3, [C2]),
      premise(P1),
      constraint("D4E5F6G8", [P1, C1]),
    ];
    const first = layeredLayout(cyclic, "LR");
    expect(first).toHaveLength(cyclic.length);
    for (const node of first) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
    expect(layeredLayout(cyclic, "LR")).toEqual(first);
  });
});

describe("direction mapping", () => {
  const chain = [premise(P1), constraint(C1, [P1]), constraint(C2, [C1])];

  it("maps layers to the chosen axis without changing the layout", () => {
    const lr = layeredLayout(chain, "LR");
    const tb = layeredLayout(chain, "TB");
    // LR: layers grow along x; TB: layers grow along y. A single-child chain
    // centers on its ground's row, so the TB chain is a straight line.
    expect(byId(lr, C2).x).toBeGreaterThan(byId(lr, C1).x);
    expect(byId(tb, C2).y).toBeGreaterThan(byId(tb, C1).y);
    expect(byId(tb, C1).x).toBe(byId(tb, P1).x);
  });

  it("mirrors RL and BT", () => {
    const lr = layeredLayout(chain, "LR");
    const rl = layeredLayout(chain, "RL");
    expect(byId(rl, C1).x).toBeLessThan(byId(rl, P1).x);
    expect(byId(rl, P1).y).toBe(byId(lr, P1).y);
    const bt = layeredLayout(chain, "BT");
    expect(byId(bt, C1).y).toBeLessThan(byId(bt, P1).y);
  });
});
