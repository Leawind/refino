// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { layoutGraph } from "../src/graph/layout";
import type { NodeRecord } from "../src/types";

function node(id: string, grounds?: string[]): NodeRecord {
  return {
    id,
    type: grounds === undefined ? "premise" : "constraint",
    file: `nodes/${id.slice(0, 2)}/${id.slice(2)}.md`,
    summary: `summary of ${id}`,
    body: `body of ${id}`,
    grounds,
    dependents: [],
  };
}

// premise -> constraint -> constraint
const fixture: NodeRecord[] = [
  node("P1AAAAAA"),
  node("C1AAAAAA", ["P1AAAAAA"]),
  node("C2AAAAAA", ["C1AAAAAA"]),
  node("R1AAAAAA"), // second root
];

describe("graph layout", () => {
  it("assigns layers along the grounds edges", () => {
    const { nodes } = layoutGraph(fixture, "LR");
    const x = new Map(nodes.map((n) => [n.id, n.x]));
    expect(x.get("P1AAAAAA")!).toBeLessThan(x.get("C1AAAAAA")!);
    expect(x.get("C1AAAAAA")!).toBeLessThan(x.get("C2AAAAAA")!);
    // Both roots share the first layer.
    expect(x.get("R1AAAAAA")!).toBe(x.get("P1AAAAAA")!);
  });

  it("maps the direction onto the axes", () => {
    const tb = layoutGraph(fixture, "TB");
    const get = (g: ReturnType<typeof layoutGraph>, id: string) =>
      g.nodes.find((n) => n.id === id)!;
    // In LR depth grows along x, in TB along y.
    expect(get(tb, "P1AAAAAA").y).toBeLessThan(get(tb, "C1AAAAAA").y);
    expect(get(tb, "P1AAAAAA").y).toBe(get(tb, "R1AAAAAA").y); // same layer
    // RL mirrors LR along x.
    const rl = layoutGraph(fixture, "RL");
    expect(get(rl, "C2AAAAAA").x).toBeLessThan(get(rl, "P1AAAAAA").x);
  });

  it("produces one edge per grounds reference with a path", () => {
    const { edges } = layoutGraph(fixture, "TB");
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.path.startsWith("M "))).toBe(true);
  });

  it("normalizes coordinates into the bounding box", () => {
    const { nodes, width, height } = layoutGraph(fixture, "BT");
    expect(nodes.every((n) => n.x >= 0 && n.y >= 0)).toBe(true);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });
});
