import { describe, expect, it } from "vitest";
import { NODE_HEIGHT, NODE_WIDTH } from "../src/graph/layout/engine";
import { forceStrategy } from "../src/graph/layout/force";
import type { LayoutNode } from "../src/graph/layout/types";

function chain(length: number): LayoutNode[] {
  return Array.from({ length }, (_, i) => ({
    id: `n${i}`,
    grounds: i === 0 ? [] : [`n${i - 1}`],
  }));
}

/** A diamond: two paths joining again — exercise family spreading. */
function diamond(): LayoutNode[] {
  return [
    { id: "a", grounds: [] },
    { id: "b", grounds: ["a"] },
    { id: "c", grounds: ["a"] },
    { id: "d", grounds: ["b", "c"] },
  ];
}

/** Steps until settled (bounded by the session's own step budget). */
function settled(session: ReturnType<typeof forceStrategy.createSession>) {
  let last = session.positions();
  for (let i = 0; i < 2000 && session.animating; i++) last = session.step(16);
  return last;
}

function overlaps(nodes: ReturnType<typeof settled>): boolean {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      if (Math.abs(a.x - b.x) < NODE_WIDTH - 1 && Math.abs(a.y - b.y) < NODE_HEIGHT - 1) {
        return true;
      }
    }
  }
  return false;
}

describe("force session", () => {
  it("converges and stops animating", () => {
    const session = forceStrategy.createSession(chain(12), { direction: "LR" });
    expect(session.animating).toBe(true);
    const final = settled(session);
    expect(session.animating).toBe(false);
    expect(final).toHaveLength(12);
    session.dispose();
  });

  it("settled nodes do not overlap", () => {
    for (const nodes of [chain(6), diamond()]) {
      const session = forceStrategy.createSession(nodes, { direction: "LR" });
      expect(overlaps(settled(session))).toBe(false);
      session.dispose();
    }
  });

  it("keeps grounds edges near the target length", () => {
    const nodes = chain(8);
    const session = forceStrategy.createSession(nodes, { direction: "LR" });
    const positions = new Map(settled(session).map((n) => [n.id, n] as const));
    for (let i = 1; i < nodes.length; i++) {
      const a = positions.get(`n${i - 1}`)!;
      const b = positions.get(`n${i}`)!;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      expect(d).toBeGreaterThan(NODE_WIDTH);
      expect(d).toBeLessThan(600);
    }
    session.dispose();
  });

  it("is deterministic for the same node set", () => {
    const run = (): Array<[string, number, number]> => {
      const session = forceStrategy.createSession(chain(10), { direction: "LR" });
      const final = settled(session);
      session.dispose();
      return final.map((n) => [n.id, n.x, n.y]);
    };
    expect(run()).toEqual(run());
  });

  it("is order-independent: same set in any input order", () => {
    const forward = chain(8);
    const shuffled = [...forward].reverse();
    const s1 = forceStrategy.createSession(forward, { direction: "LR" });
    const s2 = forceStrategy.createSession(shuffled, { direction: "LR" });
    const r1 = settled(s1).map((n) => [n.id, n.x, n.y]);
    const r2 = settled(s2).map((n) => [n.id, n.x, n.y]);
    expect(r1).toEqual(r2);
    s1.dispose();
    s2.dispose();
  });

  it("a settled session keeps returning identical geometry", () => {
    const session = forceStrategy.createSession(diamond(), { direction: "TB" });
    settled(session);
    const once = session.step(1000);
    expect(session.step(1000)).toEqual(once);
    session.dispose();
  });
});
