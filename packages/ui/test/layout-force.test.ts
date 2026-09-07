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

  it("packs and stamps the configured card size", () => {
    const size = { width: 300, height: 100 };
    const session = forceStrategy.createSession(chain(8), { direction: "LR", nodeSize: size });
    const final = settled(session);
    session.dispose();
    for (const node of final) {
      expect(node.width).toBe(size.width);
      expect(node.height).toBe(size.height);
    }
    // No card overlaps at the configured footprint: any overlap would put
    // the centers closer than the card diagonal, below the packed radius.
    for (let i = 0; i < final.length; i++) {
      for (let j = i + 1; j < final.length; j++) {
        const a = final[i]!;
        const b = final[j]!;
        const separated =
          a.x + size.width <= b.x ||
          b.x + size.width <= a.x ||
          a.y + size.height <= b.y ||
          b.y + size.height <= a.y;
        expect(separated).toBe(true);
      }
    }
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

  it("orients the grounds flow along the main axis (LR)", () => {
    const session = forceStrategy.createSession(chain(8), { direction: "LR" });
    const positions = new Map(settled(session).map((n) => [n.id, n] as const));
    session.dispose();
    for (let i = 1; i < 8; i++) {
      expect(positions.get(`n${i}`)!.x).toBeGreaterThan(positions.get(`n${i - 1}`)!.x);
    }
  });

  it("TB puts downstream further down; RL puts it further left", () => {
    const tb = forceStrategy.createSession(chain(6), { direction: "TB" });
    const down = new Map(settled(tb).map((n) => [n.id, n] as const));
    tb.dispose();
    for (let i = 1; i < 6; i++) {
      expect(down.get(`n${i}`)!.y).toBeGreaterThan(down.get(`n${i - 1}`)!.y);
    }
    const rl = forceStrategy.createSession(chain(6), { direction: "RL" });
    const left = new Map(settled(rl).map((n) => [n.id, n] as const));
    rl.dispose();
    for (let i = 1; i < 6; i++) {
      expect(left.get(`n${i}`)!.x).toBeLessThan(left.get(`n${i - 1}`)!.x);
    }
  });

  it("motion decays smoothly to a stop instead of rattle-then-cutoff", () => {
    const session = forceStrategy.createSession(chain(40), { direction: "LR" });
    let prev = session.positions();
    const moves: number[] = [];
    for (let i = 0; i < 2000 && session.animating; i++) {
      const next = session.step(16);
      moves.push(Math.max(...next.map((n, j) => Math.hypot(n.x - prev[j]!.x, n.y - prev[j]!.y))));
      prev = next;
    }
    expect(session.animating).toBe(false);
    // The alpha schedule shrinks every force geometrically, so per-tick
    // motion collapses towards zero: the final quarter stays far below the
    // opening phase, with no full-strength jitter surviving to the cutoff.
    const opening = Math.max(...moves.slice(0, Math.floor(moves.length / 4)));
    const tail = Math.max(...moves.slice(Math.floor((moves.length * 3) / 4)));
    expect(tail).toBeLessThan(opening * 0.05);
    expect(tail).toBeLessThan(5);
    session.dispose();
  });

  it("a carried seed reheats gently instead of re-swimming", () => {
    const first = forceStrategy.createSession(chain(20), { direction: "LR" });
    const settledFirst = settled(first);
    first.dispose();
    const seed = new Map(settledFirst.map((n) => [n.id, { x: n.x, y: n.y }] as const));

    // The same node set re-seeded from its own settled coordinates needs
    // far fewer ticks than a fresh full relaxation.
    const again = forceStrategy.createSession(chain(20), { direction: "LR", seed });
    let ticks = 0;
    while (again.animating && ticks < 2000) {
      again.step(16);
      ticks += 1;
    }
    expect(ticks).toBeLessThan(150);
    const after = new Map(settled(again).map((n) => [n.id, n] as const));
    again.dispose();
    for (const [id, p] of seed) {
      const q = after.get(id)!;
      expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeLessThan(60);
    }

    // A node added later joins near its ground and the link settles at a
    // sane length without disturbing the carried coordinates.
    const grown: LayoutNode[] = [...chain(20), { id: "n20", grounds: ["n19"] }];
    const grownSession = forceStrategy.createSession(grown, { direction: "LR", seed });
    const positions = new Map(settled(grownSession).map((n) => [n.id, n] as const));
    grownSession.dispose();
    const a = positions.get("n19")!;
    const b = positions.get("n20")!;
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(NODE_WIDTH);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThan(600);
    const seedN19 = seed.get("n19")!;
    // The ground absorbs the newcomer with a local adjustment (about half
    // a card slot along the main axis), not a full-graph re-swim.
    expect(Math.hypot(a.x - seedN19.x, a.y - seedN19.y)).toBeLessThan(150);
  });

  it("pins a dragged node at the pointer and releases it back", () => {
    const session = forceStrategy.createSession(chain(8), { direction: "LR" });
    settled(session);
    // Fixing a settled session revives it: the drag owns the lifecycle.
    session.fix?.("n5", -1000, -1000);
    expect(session.animating).toBe(true);
    session.step(16);
    session.step(16);
    const pinned = session.positions().find((n) => n.id === "n5")!;
    expect(pinned.x).toBeCloseTo(-1000, 6);
    expect(pinned.y).toBeCloseTo(-1000, 6);
    // Releasing frees the node: it relaxes back toward its neighbourhood
    // and the session settles again.
    session.release?.("n5");
    expect(session.animating).toBe(true);
    const final = settled(session);
    const free = final.find((n) => n.id === "n5")!;
    expect(free.x).toBeGreaterThan(-1000);
    // Its grounds link recovers a sane length.
    const n4 = final.find((n) => n.id === "n4")!;
    expect(Math.hypot(free.x - n4.x, free.y - n4.y)).toBeGreaterThan(NODE_WIDTH);
    expect(Math.hypot(free.x - n4.x, free.y - n4.y)).toBeLessThan(600);
    session.dispose();
  });
});
