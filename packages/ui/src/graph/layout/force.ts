import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { layeredLayout, NODE_HEIGHT, NODE_WIDTH } from "./engine";
import type {
  LaidOutNode,
  LayoutNode,
  LayoutOptions,
  LayoutSession,
  LayoutStrategy,
} from "./types";

/**
 * Force-directed layout (ui DESIGN.md, "布局"), powered by d3-force.
 *
 * Seeded from the layered layout (deterministic, already readable), then
 * relaxed by a d3 simulation: springs on grounds edges, Barnes-Hut pair
 * repulsion, circle packing against card overlap, and slight gravity
 * toward the viewport center. d3's alpha schedule scales every force and
 * decays it exponentially, so motion shrinks smoothly to a stop instead of
 * rattling at full strength until a hard cutoff.
 *
 * Determinism: nodes are laid out in id-sorted array order (d3 iterates
 * nodes in array order), and the random source stays d3's fixed-seed LCG,
 * so the same input always converges to the same layout.
 */

/** Desired center-to-center length of a grounds edge. */
const EDGE_LENGTH = 240;
/** Pair repulsion strength: d3 manyBody applies strength/d, so this is the
 * k in k/d — order-of-magnitude the d3 default (-30), a bit firmer for
 * 150-px-wide cards. */
const REPULSION = -100;
/** Inverse-square floor: below this center distance the push stops growing,
 * keeping near-contact motion orderly instead of divergent. */
const REPULSION_FLOOR = 160;
/** Gravity toward the viewport center. Weak on purpose: the repulsion and
 * packing forces set the spacing, gravity only keeps disjoint groups from
 * drifting apart indefinitely. */
const GRAVITY = 0.002;
/** Circle-packing radius that guarantees non-overlapping cards: a center
 * distance of twice this value separates any two card rectangles. The
 * small slack lets the iterative packing fully resolve, leaving no
 * residual overlaps. */
const COLLIDE_RADIUS = Math.hypot(NODE_WIDTH, NODE_HEIGHT) / 2 + 2;
/** Velocity kept after each tick; the rest bleeds off as friction. */
const VELOCITY_DECAY = 0.4;
/** Exponential cooling: forces scale by alpha, which decays per tick until
 * ALPHA_MIN — motion shrinks smoothly to zero (no hard cutoff). */
const ALPHA_DECAY = 0.0228;
const ALPHA_MIN = 0.001;
/** Hard tick budget: converging layouts must still terminate. */
const MAX_TICKS = 900;
/** Fixed-interval physics: one tick per this many ms of frame budget, so
 * the convergence path (and result) never depends on frame rate. */
const TICK_MS = 16;
/** Clamp for huge frame gaps (tab background, debugger pause). */
const MAX_DT = 48;

interface Body extends SimulationNodeDatum {
  id: string;
}

/** Relaxing session of a fixed node set; steps until alpha decays out. */
class ForceSession implements LayoutSession {
  readonly #bodies: Body[];
  readonly #sim: Simulation<Body, SimulationLinkDatum<Body>>;
  #ticks = 0;
  #animating = true;

  constructor(nodes: readonly LayoutNode[], options: LayoutOptions) {
    void options;
    // Layered positions as the seed: deterministic and a natural starting
    // shape, so switching layouts mid-session reads as a small relaxation.
    const seed = new Map(layeredLayout(nodes, "LR").map((n) => [n.id, n] as const));
    // Id-sorted array order: d3 iterates nodes in array order, and the
    // layout must not depend on the input order (ui DESIGN, "布局").
    this.#bodies = [...seed.keys()].sort().map((id) => ({
      id,
      x: seed.get(id)!.x,
      y: seed.get(id)!.y,
    }));
    const grounds = new Map(nodes.map((n) => [n.id, n.grounds ?? []] as const));
    const links: SimulationLinkDatum<Body>[] = this.#bodies.flatMap((body) =>
      (grounds.get(body.id) ?? [])
        .filter((g) => seed.has(g))
        .map((g) => ({ source: g, target: body.id })),
    );
    this.#sim = forceSimulation<Body>(this.#bodies)
      .force(
        "link",
        forceLink<Body, SimulationLinkDatum<Body>>(links)
          .id((body) => body.id)
          .distance(EDGE_LENGTH),
      )
      .force("charge", forceManyBody<Body>().strength(REPULSION).distanceMin(REPULSION_FLOOR))
      .force("collide", forceCollide<Body>(COLLIDE_RADIUS).iterations(3))
      .force("x", forceX<Body>(0).strength(GRAVITY))
      .force("y", forceY<Body>(0).strength(GRAVITY))
      .force("center", forceCenter<Body>(0, 0))
      .alphaDecay(ALPHA_DECAY)
      .velocityDecay(VELOCITY_DECAY)
      .stop(); // no internal timer: the canvas drives ticks via step()
    // Nothing to relax with at most one body.
    if (this.#bodies.length <= 1) this.#animating = false;
  }

  get animating(): boolean {
    return this.#animating;
  }

  positions(): readonly LaidOutNode[] {
    return this.#bodies.map((body) => ({
      id: body.id,
      x: body.x ?? 0,
      y: body.y ?? 0,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    }));
  }

  step(dtMs: number): readonly LaidOutNode[] {
    if (!this.#animating) return this.positions();
    // Fixed physics regardless of frame timing: accumulate clamped slices
    // so the convergence path (and result) never depends on frame rate.
    let budget = Math.min(Math.max(dtMs, 0), MAX_DT);
    while (budget > 0 && this.#animating) {
      this.#sim.tick();
      this.#ticks += 1;
      budget -= TICK_MS;
      if (this.#sim.alpha() < ALPHA_MIN || this.#ticks >= MAX_TICKS) {
        this.#animating = false;
      }
    }
    return this.positions();
  }

  dispose(): void {
    this.#animating = false;
    this.#sim.stop();
  }
}

/** Force-directed strategy: seeded relaxation until settled. */
export const forceStrategy: LayoutStrategy = {
  id: "force",
  createSession(nodes: readonly LayoutNode[], options: LayoutOptions): LayoutSession {
    return new ForceSession(nodes, options);
  },
};
