import { describe, expect, it } from "vitest";
import { OrbitForceSession } from "../src/graph/orbit/force";
import type { OrbitForceEdgeInput, OrbitForceNodeInput } from "../src/graph/orbit/force";

/**
 * The orbit force layout (ui DESIGN.md, "三维视图"): springs follow every
 * grounds edge, the virtual root anchors the roots, and generation distance
 * is read from the settled radii instead of being pinned to shells.
 */

/** A root with `children` children, each with the same number of children. */
function tree(depth: number, branch: number) {
  const nodes: OrbitForceNodeInput[] = [];
  const edges: OrbitForceEdgeInput[] = [];
  let next = 0;
  const add = (nodeDepth: number, parent: string | null): string => {
    const id = `n${next++}`;
    nodes.push({ id, x: 0, y: 0, z: 0, depth: nodeDepth, root: nodeDepth === 1 });
    if (parent !== null) edges.push({ from: parent, to: id });
    if (nodeDepth < depth) {
      for (let index = 0; index < branch; index += 1) add(nodeDepth + 1, id);
    }
    return id;
  };
  add(1, null);
  // Deterministic radial seed, like the shell layout.
  nodes.forEach((node, index) => {
    const angle = index * 2.399963;
    const radius = 5.5 + 3 * (node.depth - 1);
    node.x = Math.cos(angle) * radius;
    node.y = Math.sin(angle) * 0.6 * radius;
    node.z = Math.sin(angle * 0.7) * 0.8 * radius;
  });
  return { nodes, edges };
}

function radiusOf(session: OrbitForceSession, id: string): number {
  const point = session.positions.get(id)!;
  return Math.hypot(point.x, point.y, point.z);
}

function pairDistance(session: OrbitForceSession, a: string, b: string): number {
  const left = session.positions.get(a)!;
  const right = session.positions.get(b)!;
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

describe("orbit force layout", () => {
  it("settles with each generation farther from the core", () => {
    const { nodes, edges } = tree(4, 2);
    const session = new OrbitForceSession(nodes, edges);
    session.settle(2000);
    expect(session.settled).toBe(true);
    for (const edge of edges) {
      const from = nodes.find((node) => node.id === edge.from)!;
      const to = nodes.find((node) => node.id === edge.to)!;
      expect(radiusOf(session, to.id)).toBeGreaterThan(radiusOf(session, from.id));
    }
    // The whole ball is finite and spaced.
    expect(session.extent()).toBeGreaterThan(5);
    expect(session.extent()).toBeLessThan(100);
  });

  it("keeps stars apart instead of collapsing onto one another", () => {
    const { nodes, edges } = tree(3, 3);
    const session = new OrbitForceSession(nodes, edges);
    session.settle(2000);
    const positions = [...session.positions.values()];
    for (let left = 0; left < positions.length; left += 1) {
      for (let right = left + 1; right < positions.length; right += 1) {
        const a = positions[left]!;
        const b = positions[right]!;
        expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeGreaterThan(3);
      }
    }
  });

  it("holds a dragged body and pulls its neighbours", () => {
    const { nodes, edges } = tree(2, 2);
    const session = new OrbitForceSession(nodes, edges);
    session.settle(2000);
    const root = "n0";
    const child = "n1";
    const before = pairDistance(session, root, child);
    const target = { x: 12, y: 0, z: 0 };
    session.pin(root, target);
    session.settle(2000);
    // The pin never moves; the child follows the new geometry.
    expect(session.positions.get(root)).toMatchObject(target);
    expect(pairDistance(session, root, child)).not.toBeCloseTo(before, 3);
    session.pin(root, null);
    session.settle(2000);
    expect(session.settled).toBe(true);
  });

  it("stays put once settled", () => {
    const { nodes, edges } = tree(2, 2);
    const session = new OrbitForceSession(nodes, edges);
    session.settle(2000);
    const snapshot = [...session.positions].map(([id, point]) => [id, { ...point }] as const);
    expect(session.step()).toBe(false);
    for (const [id, point] of snapshot) {
      expect(session.positions.get(id)).toMatchObject(point);
    }
  });

  it("produces the same layout for the same input", () => {
    const { nodes, edges } = tree(3, 2);
    const first = new OrbitForceSession(nodes, edges);
    const second = new OrbitForceSession(nodes, edges);
    first.settle(400);
    second.settle(400);
    for (const [id, point] of first.positions) {
      const other = second.positions.get(id)!;
      expect(point.x).toBeCloseTo(other.x, 9);
      expect(point.y).toBeCloseTo(other.y, 9);
      expect(point.z).toBeCloseTo(other.z, 9);
    }
  });

  it("starts carried-over bodies where they were", () => {
    const { nodes, edges } = tree(2, 2);
    const seed = new Map([["n0", { x: 7, y: 1, z: -2 }]]);
    const session = new OrbitForceSession(nodes, edges, seed);
    expect(session.positions.get("n0")).toMatchObject({ x: 7, y: 1, z: -2 });
  });
});
