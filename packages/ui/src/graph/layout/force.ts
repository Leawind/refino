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
import { assignLayers } from "refino";
import type { LayoutDirection } from "../../types";
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
 * First entry relaxes from the layered layout; later sessions carry the
 * previous session's coordinates over (options.seed) and only reheat
 * gently, so working-set changes nudge the layout instead of re-swimming
 * it. Nodes unknown to the seed join near the centroid of their grounds.
 * A d3 simulation relaxes the graph: springs on grounds edges, Barnes-Hut
 * pair repulsion, circle packing against card overlap, and a main-axis
 * pull that places every node at its grounds-depth layer along the display
 * direction — the upstream→downstream flow reads as position. d3's alpha
 * schedule scales every force and decays it exponentially, so motion
 * shrinks smoothly to a stop instead of rattling at full strength until a
 * hard cutoff.
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
/** Cross-axis gravity toward the viewport center line. Weak on purpose: it
 * only keeps disconnected groups from drifting apart on the cross axis —
 * the main axis is owned by the layer targets, spacing by repulsion and
 * packing. */
const GRAVITY = 0.002;
/** Main-axis pull toward each node's layer position (grounds longest-path
 * depth × the edge length, signed by the display direction). Strong enough
 * to keep the upstream→downstream flow readable, loose enough that springs
 * and packing own the cross axis and spacing. */
const MAIN_AXIS_STRENGTH = 0.08;
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
/** A carried-over seed only needs a partial reheat: known coordinates are
 * already balanced, so a shorter, gentler relaxation suffices. */
const REHEAT_ALPHA = 0.4;
const REHEAT_ALPHA_DECAY = 0.06;
/** Alpha floor while a node drag is in progress: the neighbourhood keeps
 * relaxing around the pinned node for the whole gesture. */
const DRAG_ALPHA = 0.3;
/** Offset that separates a new node from the exact centroid of its grounds
 * so coincident starts never happen; derived from the id's rank, hence
 * deterministic. */
const JOIN_OFFSET = 12;
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
  readonly #byId = new Map<string, Body>();
  readonly #sim: Simulation<Body, SimulationLinkDatum<Body>>;
  #ticks = 0;
  #animating = true;
  /** True while a node is pinned to the pointer: the relaxation keeps
   * running (and neighbors keep reacting) no matter how quiet it is. */
  #dragging = false;

  constructor(nodes: readonly LayoutNode[], options: LayoutOptions) {
    // Fallback seed: layered positions are deterministic and a natural
    // starting shape, so the first force session starts from a readable
    // layout. A carried-over seed (previous session) wins per node.
    const layered = new Map(layeredLayout(nodes, "LR").map((n) => [n.id, n] as const));
    const carried = options.seed;
    // Main axis: grounds longest-path depth (the same layering the layered
    // layout uses) sets each node's target coordinate along the display
    // direction, so the upstream→downstream flow reads as position.
    const direction: LayoutDirection = options.direction;
    const horizontal = direction === "LR" || direction === "RL";
    const sign = direction === "LR" || direction === "TB" ? 1 : -1;
    const layers = assignLayers([...nodes].sort((a, b) => (a.id < b.id ? -1 : 1)));
    const axisTarget = (id: string): number => sign * (layers.get(id) ?? 0) * EDGE_LENGTH;
    // Id-sorted array order: d3 iterates nodes in array order, and the
    // layout must not depend on the input order (ui DESIGN, "布局").
    const ids = [...layered.keys()].sort();
    const grounds = new Map(nodes.map((n) => [n.id, n.grounds ?? []] as const));
    // Known nodes keep their coordinates; new nodes start near the
    // centroid of their (already placed) grounds, falling back to the
    // layered position. Placing in id order makes each lookup deterministic.
    const start = new Map<string, { x: number; y: number }>();
    let carriedCount = 0;
    ids.forEach((id, rank) => {
      const known = carried?.get(id);
      if (known !== undefined) {
        carriedCount += 1;
        start.set(id, { x: known.x, y: known.y });
        return;
      }
      const anchorIds = (grounds.get(id) ?? []).filter((g) => start.has(g));
      if (anchorIds.length === 0) {
        const fallback = layered.get(id)!;
        start.set(id, { x: fallback.x, y: fallback.y });
        return;
      }
      let ax = 0;
      let ay = 0;
      for (const g of anchorIds) {
        ax += start.get(g)!.x;
        ay += start.get(g)!.y;
      }
      // Join beside the family centroid, offset circling by rank so nodes
      // never start exactly on top of each other.
      const angle = (rank % 8) * (Math.PI / 4);
      start.set(id, {
        x: ax / anchorIds.length + Math.cos(angle) * JOIN_OFFSET,
        y: ay / anchorIds.length + Math.sin(angle) * JOIN_OFFSET,
      });
    });
    this.#bodies = ids.map((id) => ({
      id,
      x: start.get(id)!.x,
      y: start.get(id)!.y,
    }));
    for (const body of this.#bodies) this.#byId.set(body.id, body);
    const links: SimulationLinkDatum<Body>[] = this.#bodies.flatMap((body) =>
      (grounds.get(body.id) ?? [])
        .filter((g) => start.has(g))
        .map((g) => ({ source: g, target: body.id })),
    );
    const reheated = carried !== undefined && carriedCount > 0;
    const axis = horizontal
      ? forceX<Body>((body) => axisTarget(body.id)).strength(MAIN_AXIS_STRENGTH)
      : forceY<Body>((body) => axisTarget(body.id)).strength(MAIN_AXIS_STRENGTH);
    const crossGravity = horizontal
      ? forceY<Body>(0).strength(GRAVITY)
      : forceX<Body>(0).strength(GRAVITY);
    this.#sim = forceSimulation<Body>(this.#bodies)
      .force(
        "link",
        forceLink<Body, SimulationLinkDatum<Body>>(links)
          .id((body) => body.id)
          .distance(EDGE_LENGTH),
      )
      .force("charge", forceManyBody<Body>().strength(REPULSION).distanceMin(REPULSION_FLOOR))
      .force("collide", forceCollide<Body>(COLLIDE_RADIUS).iterations(3))
      .force("axis", axis)
      .force("cross", crossGravity)
      .force("center", forceCenter<Body>(0, 0))
      .alpha(reheated ? REHEAT_ALPHA : 1)
      .alphaDecay(reheated ? REHEAT_ALPHA_DECAY : ALPHA_DECAY)
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
      // A pinned node holds the relaxation open: the drag decides when it
      // ends, not the alpha schedule.
      if (!this.#dragging && (this.#sim.alpha() < ALPHA_MIN || this.#ticks >= MAX_TICKS)) {
        this.#animating = false;
      }
    }
    return this.positions();
  }

  /** Pins the node at the pointer position and keeps the neighbourhood
   * relaxing: the alpha floor holds the simulation warm for the whole
   * drag, and neighbors react through their springs. */
  fix(id: string, x: number, y: number): void {
    const body = this.#byId.get(id);
    if (body === undefined) return;
    body.fx = x;
    body.fy = y;
    this.#dragging = true;
    this.#animating = true;
    this.#ticks = 0;
    this.#sim.alphaTarget(DRAG_ALPHA);
    this.#sim.alpha(Math.max(this.#sim.alpha(), DRAG_ALPHA));
  }

  /** Releases the node from the pointer: the forces take it back and the
   * session settles gently. */
  release(id: string): void {
    const body = this.#byId.get(id);
    if (body !== undefined) {
      body.fx = undefined;
      body.fy = undefined;
    }
    this.#dragging = false;
    this.#animating = true;
    this.#ticks = 0;
    this.#sim.alphaTarget(0);
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
