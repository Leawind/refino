import { layeredLayout, NODE_HEIGHT, NODE_WIDTH } from "./engine";
import type {
  LaidOutNode,
  LayoutNode,
  LayoutOptions,
  LayoutSession,
  LayoutStrategy,
} from "./types";

/**
 * Force-directed layout (ui README, "布局：力导向").
 *
 * Seeded from the layered layout (deterministic, already readable), then
 * relaxed each step by spring forces on grounds edges, pair repulsion and
 * a slight gravity toward the centroid, until movements fall below the
 * settle threshold. The display direction is meaningless for a physical
 * relaxation and is ignored.
 *
 * Determinism: the seed, the force sums and the iteration order all
 * follow the id-sorted node set, so the same input always converges to
 * the same layout.
 */

/** Desired center-to-center length of a grounds edge. */
const EDGE_LENGTH = 240;
/** Spring stiffness (force per unit of length error). */
const SPRING = 0.02;
/** Pair repulsion strength. */
const REPULSION = 24000;
/** Gravity pull toward the centroid (fraction per unit distance). */
const GRAVITY = 0.01;
/** Velocity kept after each step; the rest bleeds off as friction. */
const DAMPING = 0.6;
/** Per-step displacement cap (virtual units) to keep steps stable. */
const MAX_MOVE = 24;
/** Settled once every node moves less than this for `QUIET_STEPS` steps. */
const SETTLE_MOVE = 0.1;
const QUIET_STEPS = 6;
/** Hard step budget: converging layouts must still terminate. */
const MAX_STEPS = 900;
/** Clamp for huge frame gaps (tab background, debugger pause). */
const MAX_DT = 48;

interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Relaxing session of a fixed node set; steps until settled. */
class ForceSession implements LayoutSession {
  /** Ids in sorted order — the deterministic iteration order throughout. */
  readonly #ids: readonly string[];
  readonly #bodies = new Map<string, Body>();
  /** Grounds edges restricted to the node set, as id pairs. */
  readonly #edges: ReadonlyArray<readonly [string, string]>;
  #quiet = 0;
  #steps = 0;
  #animating = true;

  constructor(nodes: readonly LayoutNode[], options: LayoutOptions) {
    void options;
    // Layered positions as the seed: deterministic and a natural starting
    // shape, so switching layouts mid-session reads as a small relaxation.
    const seed = new Map(layeredLayout(nodes, "LR").map((n) => [n.id, n] as const));
    this.#ids = [...seed.keys()].sort();
    for (const id of this.#ids) {
      const node = seed.get(id)!;
      this.#bodies.set(id, { x: node.x, y: node.y, vx: 0, vy: 0 });
    }
    const byId = new Map(nodes.map((n) => [n.id, n] as const));
    this.#edges = this.#ids.flatMap((id) =>
      (byId.get(id)?.grounds ?? []).filter((g) => seed.has(g)).map((g) => [g, id] as const),
    );
  }

  get animating(): boolean {
    return this.#animating;
  }

  positions(): readonly LaidOutNode[] {
    return this.#ids.map((id) => {
      const body = this.#bodies.get(id)!;
      return { id, x: body.x, y: body.y, width: NODE_WIDTH, height: NODE_HEIGHT };
    });
  }

  step(dtMs: number): readonly LaidOutNode[] {
    if (!this.#animating) return this.positions();
    // Fixed physics regardless of frame timing: accumulate clamped slices
    // so the convergence path (and result) never depends on frame rate.
    let budget = Math.min(Math.max(dtMs, 0), MAX_DT);
    while (budget > 0 && this.#animating) {
      this.#stepOnce();
      budget -= 16;
    }
    return this.positions();
  }

  dispose(): void {
    this.#animating = false;
  }

  #stepOnce(): void {
    this.#steps += 1;
    const n = this.#ids.length;
    const fx = new Map<string, number>();
    const fy = new Map<string, number>();
    for (const id of this.#ids) {
      fx.set(id, 0);
      fy.set(id, 0);
    }

    // Springs along grounds edges.
    for (const [from, to] of this.#edges) {
      const a = this.#bodies.get(from)!;
      const b = this.#bodies.get(to)!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = SPRING * (d - EDGE_LENGTH);
      const ux = dx / d;
      const uy = dy / d;
      fx.set(from, fx.get(from)! + f * ux);
      fy.set(from, fy.get(from)! + f * uy);
      fx.set(to, fx.get(to)! - f * ux);
      fy.set(to, fy.get(to)! - f * uy);
    }

    // Pair repulsion, with a hard floor: below overlap distance the push
    // grows linearly so settled layouts never keep overlapping rectangles.
    const minDist = Math.hypot(NODE_WIDTH, NODE_HEIGHT);
    for (let i = 0; i < n; i++) {
      const a = this.#bodies.get(this.#ids[i]!)!;
      for (let j = i + 1; j < n; j++) {
        const b = this.#bodies.get(this.#ids[j]!)!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d === 0) {
          // Coincident bodies (possible in a degenerate seed): nudge apart
          // along a deterministic per-pair direction.
          const angle = ((i * 31 + j * 17) % 8) * (Math.PI / 4);
          const push = MAX_MOVE;
          fx.set(this.#ids[i]!, fx.get(this.#ids[i]!)! - Math.cos(angle) * push);
          fy.set(this.#ids[i]!, fy.get(this.#ids[i]!)! - Math.sin(angle) * push);
          fx.set(this.#ids[j]!, fx.get(this.#ids[j]!)! + Math.cos(angle) * push);
          fy.set(this.#ids[j]!, fy.get(this.#ids[j]!)! + Math.sin(angle) * push);
          continue;
        }
        const ux = dx / d;
        const uy = dy / d;
        const f = d < minDist ? REPULSION / minDist + (minDist - d) * 0.5 : REPULSION / (d * d);
        fx.set(this.#ids[i]!, fx.get(this.#ids[i]!)! - ux * f);
        fy.set(this.#ids[i]!, fy.get(this.#ids[i]!)! - uy * f);
        fx.set(this.#ids[j]!, fx.get(this.#ids[j]!)! + ux * f);
        fy.set(this.#ids[j]!, fy.get(this.#ids[j]!)! + uy * f);
      }
    }

    // Slight gravity toward the centroid keeps disjoint groups from
    // drifting apart indefinitely.
    if (n > 0) {
      let cx = 0;
      let cy = 0;
      for (const id of this.#ids) {
        cx += this.#bodies.get(id)!.x;
        cy += this.#bodies.get(id)!.y;
      }
      cx /= n;
      cy /= n;
      for (const id of this.#ids) {
        const body = this.#bodies.get(id)!;
        fx.set(id, fx.get(id)! + (cx - body.x) * GRAVITY);
        fy.set(id, fy.get(id)! + (cy - body.y) * GRAVITY);
      }
    }

    // Semi-implicit Euler with friction; displacement capped per step.
    let maxMove = 0;
    for (const id of this.#ids) {
      const body = this.#bodies.get(id)!;
      body.vx = (body.vx + fx.get(id)!) * DAMPING;
      body.vy = (body.vy + fy.get(id)!) * DAMPING;
      const dx = Math.max(-MAX_MOVE, Math.min(MAX_MOVE, body.vx));
      const dy = Math.max(-MAX_MOVE, Math.min(MAX_MOVE, body.vy));
      body.x += dx;
      body.y += dy;
      maxMove = Math.max(maxMove, Math.hypot(dx, dy));
    }

    if (maxMove < SETTLE_MOVE || this.#steps >= MAX_STEPS) {
      this.#quiet += 1;
      if (this.#quiet >= QUIET_STEPS || this.#steps >= MAX_STEPS) this.#animating = false;
    } else {
      this.#quiet = 0;
    }
  }
}

/** Force-directed strategy: seeded relaxation until settled. */
export const forceStrategy: LayoutStrategy = {
  id: "force",
  createSession(nodes: readonly LayoutNode[], options: LayoutOptions): LayoutSession {
    return new ForceSession(nodes, options);
  },
};
