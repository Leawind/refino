import { describe, expect, it } from "vitest";
import { assignLayers } from "refino";
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

/** Deterministic mulberry32 PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A wide refinement tree with cross-branch merges: three roots, growing
 * fan-out, and occasional nodes citing a second ground three layers up.
 * This is the shape that smears the layers into a directionless band when
 * the main-axis pull loses to springs and repulsion. */
function branchyTree(): LayoutNode[] {
  const rand = rng(42);
  const nodes: LayoutNode[] = [];
  const byLayer: string[][] = [[]];
  let counter = 0;
  const id = (): string => `n${String(++counter).padStart(3, "0")}`;
  for (let i = 0; i < 3; i++) {
    const root = id();
    byLayer[0].push(root);
    nodes.push({ id: root, grounds: [] });
  }
  for (let d = 1; d <= 6; d++) {
    byLayer[d] = [];
    for (const parent of byLayer[d - 1]) {
      const kids = 1 + Math.floor(rand() * 2);
      for (let k = 0; k < kids; k++) {
        const child = id();
        const grounds = [parent];
        if (d >= 3 && rand() < 0.35) {
          const old = byLayer[d - 3];
          const cand = old[Math.floor(rand() * old.length)];
          if (cand && cand !== parent) grounds.push(cand);
        }
        byLayer[d].push(child);
        nodes.push({ id: child, grounds });
      }
    }
  }
  return nodes;
}

/** Steps until settled (bounded by the session's own stability stop; the
 * bound only guards runaway tests). */
function settled(session: ReturnType<typeof forceStrategy.createSession>) {
  let last = session.positions();
  for (let i = 0; i < 50000 && session.animating; i++) last = session.step(16);
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
    // No card overlaps at the configured footprint. The contact force is a
    // stiff velocity spring, so a resting pair can keep a sub-pixel
    // equilibrium overlap against strong spring loads; allow 1px.
    for (let i = 0; i < final.length; i++) {
      for (let j = i + 1; j < final.length; j++) {
        const a = final[i]!;
        const b = final[j]!;
        const separated =
          a.x + size.width <= b.x + 1 ||
          b.x + size.width <= a.x + 1 ||
          a.y + size.height <= b.y + 1 ||
          b.y + size.height <= a.y + 1;
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

  it("keeps deep layers downstream on a wide merge-heavy tree", { timeout: 60000 }, () => {
    const nodes = branchyTree();
    const session = forceStrategy.createSession(nodes, { direction: "LR" });
    const positions = new Map(settled(session).map((n) => [n.id, n] as const));
    session.dispose();
    const layers = assignLayers(nodes);
    // Every deeper layer's mean x is strictly greater than the one before:
    // the upstream→downstream flow reads as position even on the hard shape.
    const sums = new Map<number, { sum: number; n: number }>();
    for (const [id, p] of positions) {
      const layer = layers.get(id) ?? 0;
      const bucket = sums.get(layer) ?? { sum: 0, n: 0 };
      bucket.sum += p.x;
      bucket.n += 1;
      sums.set(layer, bucket);
    }
    const ordered = [...sums.entries()].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1]![1];
      const cur = ordered[i]![1];
      expect(cur.sum / cur.n).toBeGreaterThan(prev.sum / prev.n);
    }
    // Merge-heavy trees bridge: a child with a long-span ground hangs
    // between its two grounds, so span-1 parent edges can point backward
    // at the true equilibrium (the physics-first tradeoff, ui DESIGN.md
    // "力导向"). The mean-x ordering above is the guarantee that matters;
    // this bound only guards against wholesale disorder.
    let backward = 0;
    let total = 0;
    for (const node of nodes) {
      for (const g of node.grounds ?? []) {
        const a = positions.get(g)!;
        const b = positions.get(node.id)!;
        total += 1;
        if (b.x - a.x < -60) backward += 1;
      }
    }
    expect(backward / total).toBeLessThan(0.3);
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

  it("stops only once the layout is actually stable", { timeout: 60000 }, () => {
    const session = forceStrategy.createSession(chain(40), { direction: "LR" });
    let prev = session.positions();
    const moves: number[] = [];
    while (session.animating) {
      const next = session.step(16);
      moves.push(Math.max(...next.map((n, j) => Math.hypot(n.x - prev[j]!.x, n.y - prev[j]!.y))));
      prev = next;
    }
    // The stop is decided by the physics, not a step budget: a session
    // only ends after a sustained run of quiet ticks, so the tail of the
    // run is genuinely still instead of frozen mid-motion by a decaying
    // force schedule.
    const tail = moves.slice(-30);
    expect(tail).toHaveLength(30);
    for (const move of tail) {
      expect(move).toBeLessThan(0.01);
    }
    session.dispose();
  });

  it("a carried seed continues from the settled shape instead of re-swimming", () => {
    const first = forceStrategy.createSession(chain(20), { direction: "LR" });
    const settledFirst = settled(first);
    const seed = new Map(settledFirst.map((n) => [n.id, { x: n.x, y: n.y }] as const));
    // Production seeds carry the virtual root's position too (DecisionGraph
    // includes it), so the reseeded graph hangs from exactly the same
    // anchor instead of sliding downstream on every session.
    const firstAnchor = first.anchorNode?.();
    if (firstAnchor != null) {
      seed.set(firstAnchor.id, { x: firstAnchor.x, y: firstAnchor.y });
    }
    first.dispose();

    // The same node set re-seeded from its own settled coordinates starts
    // at equilibrium and settles almost immediately.
    const again = forceStrategy.createSession(chain(20), { direction: "LR", seed });
    let ticks = 0;
    while (again.animating && ticks < 2000) {
      again.step(16);
      ticks += 1;
    }
    expect(ticks).toBeLessThan(150);
    const after = new Map(settled(again).map((n) => [n.id, n] as const));
    for (const [id, p] of seed) {
      // The anchor is not part of positions(); compare it separately below.
      if (firstAnchor != null && id === firstAnchor.id) continue;
      const q = after.get(id)!;
      expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeLessThan(60);
    }
    // The carried anchor keeps the reseeded graph hanging from the same
    // spot instead of sliding downstream.
    if (firstAnchor != null) {
      const againAnchor = again.anchorNode?.();
      expect(againAnchor).not.toBeNull();
      expect(againAnchor!.x).toBeCloseTo(firstAnchor.x, 4);
      expect(againAnchor!.y).toBeCloseTo(firstAnchor.y, 4);
    }
    again.dispose();

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

  it("honors force tuning and the common layer gap", () => {
    // With gravity and repulsion switched off the springs are the only
    // remaining force, so every link must rest at exactly one pitch —
    // card length plus the configured gap. This pins the option plumbing
    // end to end: layer gap, gravity, repulsion and friction all flow
    // from LayoutOptions into the physics.
    const gap = 200;
    const pitch = NODE_WIDTH + gap;
    const session = forceStrategy.createSession(chain(6), {
      direction: "LR",
      layerGap: gap,
      force: { gravity: 0, friction: 0.6, repulsion: 0, spring: 0.5 },
    });
    const positions = new Map(settled(session).map((n) => [n.id, n] as const));
    session.dispose();
    for (let i = 1; i < 6; i++) {
      const a = positions.get(`n${i - 1}`)!;
      const b = positions.get(`n${i}`)!;
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(pitch, 4);
    }
  });

  it("exposes the virtual root for display without leaking it into positions", () => {
    const session = forceStrategy.createSession(diamond(), { direction: "LR" });
    const final = settled(session);
    const anchor = session.anchorNode?.() ?? null;
    expect(anchor).not.toBeNull();
    // The anchor is display-only: positions() (what the camera bounds and
    // the drag/selection addressing see) never contains it.
    expect(final.some((n) => n.id === anchor!.id)).toBe(false);
    // One anchor link per working-set root; the diamond has exactly one.
    const edges = session.anchorEdges?.() ?? [];
    expect(edges).toHaveLength(1);
    expect(edges[0]!.source).toBe(anchor!.id);
    expect(edges[0]!.target).toBe("a");
    // The anchor hangs roughly one pitch upstream of the root.
    const root = final.find((n) => n.id === "a")!;
    const d = Math.hypot(root.x - anchor!.x, root.y - anchor!.y);
    expect(d).toBeGreaterThan(NODE_WIDTH);
    expect(d).toBeLessThan(600);
    // Pinning the anchor is a no-op: it is not a draggable node.
    const before = session.positions();
    session.fix?.(anchor!.id, 9999, 9999);
    expect(session.positions()).toEqual(before);
    session.release?.(anchor!.id);
    session.dispose();
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

  it("holding a pinned node does not resume slow graph drift", () => {
    const session = forceStrategy.createSession(chain(30), { direction: "LR" });
    const atRest = new Map(settled(session).map((n) => [n.id, { x: n.x, y: n.y }] as const));
    // Pin a mid node at its own settled position and hold: the relaxation
    // then runs at the drag alpha floor indefinitely, so any unbalanced
    // system-spanning force shows up as sustained translation of the whole
    // graph (the absolute cross gravity of older designs did exactly this,
    // and uncut far-field repulsion buckled the graph against the anchor).
    session.fix?.("n15", atRest.get("n15")!.x, atRest.get("n15")!.y);
    const hold = (ticks: number) => {
      for (let i = 0; i < ticks; i++) session.step(16);
      return new Map(session.positions().map((n) => [n.id, { x: n.x, y: n.y }] as const));
    };
    const mid = hold(1200);
    const after = hold(1200);
    let late = 0;
    let total = 0;
    for (const [id, p] of after) {
      const m = mid.get(id)!;
      const b = atRest.get(id)!;
      late = Math.max(late, Math.hypot(p.x - m.x, p.y - m.y));
      total = Math.max(total, Math.hypot(p.x - b.x, p.y - b.y));
    }
    // The held graph converges: residual settling finishes within the
    // first window and a second window of holding moves nothing.
    expect(late).toBeLessThan(5);
    expect(total).toBeLessThan(60);
    session.dispose();
  });

  describe("premises", () => {
    /** G(0) → M(1) → D(2); premise P supports only the deep D. */
    function deepSupport(): LayoutNode[] {
      return [
        { id: "p", premise: true },
        { id: "g", grounds: [] },
        { id: "m", grounds: ["g"] },
        { id: "d", grounds: ["m", "p"] },
      ];
    }

    it("hangs a premise just upstream of the decision it supports", () => {
      const session = forceStrategy.createSession(deepSupport(), { direction: "LR" });
      const positions = new Map(settled(session).map((n) => [n.id, n] as const));
      session.dispose();
      const g = positions.get("g")!;
      const m = positions.get("m")!;
      const p = positions.get("p")!;
      const d = positions.get("d")!;
      // The premise rests near its display layer (beside M, layer 1) —
      // not on the layer-0 frontier next to G.
      expect(p.x).toBeGreaterThan(g.x + (m.x - g.x) / 2);
      expect(Math.abs(p.x - m.x)).toBeLessThan(NODE_WIDTH);
      // Its support edge stays near one pitch instead of spanning the
      // whole graph, and everything keeps flowing downstream.
      expect(d.x).toBeGreaterThan(p.x);
      expect(d.x - p.x).toBeLessThan(600);
    });

    it("is deterministic and order-independent with premise flags", () => {
      const run = (input: LayoutNode[]) => {
        const session = forceStrategy.createSession(input, { direction: "LR" });
        const final = settled(session).map((n) => [n.id, n.x, n.y]);
        session.dispose();
        return final;
      };
      const input = deepSupport();
      expect(run(input)).toEqual(run([...input].reverse()));
    });
  });
});
