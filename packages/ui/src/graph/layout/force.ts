import {
  forceCollide,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { assignLayers } from "refino";
import type { LayoutDirection } from "../../types";
import { layeredLayout, resolveNodeSize } from "./engine";
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
 * The graph hangs from a pinned virtual root: one anchor body fixed one
 * pitch upstream of the real roots, spring-linked to every root as their
 * common ancestor. Every node feels a constant gravity along the display
 * direction (downstream), and the spring network anchored at the virtual
 * root holds the graph against that pull — a node's main-axis position
 * emerges from the balance: the deeper its layer and the heavier its
 * downstream subtree, the further it hangs. Cross-axis centering needs
 * no extra force: every node is spring-connected to the anchor, so the
 * graph settles around the anchor's cross position instead of drifting
 * toward an absolute coordinate line (which is what made held drags
 * slowly translate the whole graph in the previous design).
 *
 * Springs are Hookean — F = k·(l − natural), equal and opposite on both
 * ends. The natural length grows with the edge's layer span (a merge
 * edge reaching three layers down pulls toward three pitches, not one),
 * and the stiffness shrinks with the width of the layer the edge
 * enters: a wide layer receives many softer springs, keeping its total
 * upstream pull constant instead of over-constraining crowded layers.
 * Repulsion and circle packing keep cards apart and settle the cross
 * axis; velocity decay and d3's alpha schedule scale every force down
 * exponentially, so motion shrinks smoothly to a stop. Because every
 * force (including the custom spring and gravity) is scaled by the same
 * alpha, the equilibrium is alpha-invariant: holding a drag at the
 * alpha floor relaxes neighbours toward the same resting shape.
 *
 * Determinism: nodes are laid out in id-sorted array order and the
 * custom forces iterate their bodies and springs in construction
 * order, and the random source stays d3's fixed-seed LCG, so the same
 * input always converges to the same layout.
 */

/** Desired center-to-center length of one grounds-layer pitch: the
 * spring rest length of an edge grows by one pitch per layer span, so a
 * parent–child pair settles one pitch apart. */
const EDGE_LENGTH = 240;
/** Pair repulsion strength: d3 manyBody applies strength/d, so this is the
 * k in k/d — order-of-magnitude the d3 default (-30), a bit firmer for
 * reference-size cards. */
const REPULSION = -100;
/** Inverse-square floor: below this center distance the push stops growing,
 * keeping near-contact motion orderly instead of divergent. */
const REPULSION_FLOOR = 160;
/** Repulsion cutoff: pair repulsion is a local spacing force (layer mates
 * and adjacent layers sit well inside this radius), not a system-spanning
 * load. Without the cutoff the far half of a long graph pushes on the
 * near half faster than gravity, compressing the chain against the anchor
 * and laterally buckling it — and the resulting collective mode relaxes
 * slower than the alpha schedule, resuming as slow drift whenever a held
 * drag keeps the simulation warm. */
const REPULSION_RANGE = 500;
/** Constant downstream gravity every node feels along the display
 * direction. It loads the spring chain hanging from the anchor, so it
 * must stay small next to the spring stiffness: near the anchor a
 * spring carries the pull of the whole downstream subtree, and its
 * stretch is load/k. */
const GRAVITY = 0.05;
/** Hookean spring stiffness scale: each spring gets this divided by the
 * node count of the layer its downstream end sits in, so a wide layer
 * receives many softer springs while the total pull entering the layer
 * stays constant. */
const SPRING_K = 0.3;
/** Circle-packing slack beyond half the card diagonal: a center distance of
 * twice the packed radius separates any two card rectangles. The small
 * slack lets the iterative packing fully resolve, leaving no residual
 * overlaps. */
const COLLIDE_SLACK = 2;
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

/** Internal id of the virtual-root anchor body. Never exposed through
 * positions() or the fix/release addressing, so it cannot collide with
 * real node ids in any observable way. */
const ANCHOR_ID = "\u0000anchor";

interface Body extends SimulationNodeDatum {
  id: string;
  /** Anchor bodies are spring endpoints only: pinned at construction,
   * no charge, no collision radius, never reported as laid out. */
  anchor: boolean;
}

/** A Hookean grounds spring. */
interface Spring {
  source: Body;
  target: Body;
  /** Stiffness: F = k·(l − natural). */
  k: number;
  /** Rest length: the grounds layer span times one pitch. */
  natural: number;
}

/** Relaxing session of a fixed node set; steps until alpha decays out. */
class ForceSession implements LayoutSession {
  readonly #bodies: Body[];
  readonly #byId = new Map<string, Body>();
  /** Springs are custom Hookean forces, so the simulation carries the link
   * datum type only to satisfy d3's generic signature. */
  readonly #sim: Simulation<Body, SimulationLinkDatum<Body>>;
  /** The shared card geometry this session spaces and stamps. */
  readonly #size: { width: number; height: number };
  #ticks = 0;
  #animating = true;
  /** True while a node is pinned to the pointer: the relaxation keeps
   * running (and neighbors keep reacting) no matter how quiet it is. */
  #dragging = false;

  constructor(nodes: readonly LayoutNode[], options: LayoutOptions) {
    this.#size = resolveNodeSize(options);
    const direction: LayoutDirection = options.direction;
    const horizontal = direction === "LR" || direction === "RL";
    const sign = direction === "LR" || direction === "TB" ? 1 : -1;
    // Fallback seed: layered positions are deterministic, a natural starting
    // shape, and already oriented along the display direction, so the first
    // force session starts from a readable layout. A carried-over seed
    // (previous session) wins per node.
    const layered = new Map(
      layeredLayout(nodes, direction, this.#size).map((n) => [n.id, n] as const),
    );
    const carried = options.seed;
    // Grounds longest-path layers (the same layering the layered layout
    // uses): they set each spring's rest length and stiffness share.
    const layers = assignLayers([...nodes].sort((a, b) => (a.id < b.id ? -1 : 1)));
    // Id-sorted array order: d3 iterates nodes in array order, and the
    // layout must not depend on the input order (ui DESIGN, "布局").
    const ids = [...layered.keys()].sort();
    const grounds = new Map(nodes.map((n) => [n.id, n.grounds ?? []] as const));
    // Known nodes keep their coordinates; new nodes join near the centroid
    // of their (already placed) grounds. Without a carried seed every node
    // takes its layered position instead — centroid joins would start a
    // fresh graph as one tight blob, which the repulsion relaxes into a
    // stable ring rather than unfolding into the flow direction.
    // Placing in id order makes each lookup deterministic.
    const carriedCount = ids.filter((id) => carried?.has(id) ?? false).length;
    const seeded = carriedCount > 0;
    const start = new Map<string, { x: number; y: number }>();
    ids.forEach((id, rank) => {
      const known = carried?.get(id);
      if (known !== undefined) {
        start.set(id, { x: known.x, y: known.y });
        return;
      }
      const anchorIds = seeded ? (grounds.get(id) ?? []).filter((g) => start.has(g)) : [];
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
      anchor: false,
      x: start.get(id)!.x,
      y: start.get(id)!.y,
    }));
    for (const body of this.#bodies) this.#byId.set(body.id, body);
    // Stiffness shares: a spring entering layer L gets SPRING_K split
    // across that layer's node count.
    const layerCounts = new Map<number, number>();
    for (const id of ids) {
      const layer = layers.get(id) ?? 0;
      layerCounts.set(layer, (layerCounts.get(layer) ?? 0) + 1);
    }
    // The virtual root: pinned one pitch upstream of the roots' centroid,
    // so every root spring starts near its rest length and the anchor
    // keeps the carried-over graph where it is. Roots are nodes with no
    // ground inside the working set.
    const present = new Set(ids);
    const rootIds = ids.filter((id) => !(grounds.get(id) ?? []).some((g) => present.has(g)));
    let anchorBody: Body | null = null;
    if (rootIds.length > 0) {
      let ax = 0;
      let ay = 0;
      for (const id of rootIds) {
        ax += start.get(id)!.x;
        ay += start.get(id)!.y;
      }
      ax /= rootIds.length;
      ay /= rootIds.length;
      if (horizontal) ax -= sign * EDGE_LENGTH;
      else ay -= sign * EDGE_LENGTH;
      anchorBody = { id: ANCHOR_ID, anchor: true, x: ax, y: ay, fx: ax, fy: ay };
    }
    // Grounds springs, plus one anchor spring per root (span 1).
    const springs: Spring[] = [];
    if (anchorBody !== null) {
      const k = SPRING_K / (layerCounts.get(0) ?? 1);
      for (const id of rootIds) {
        springs.push({
          source: anchorBody,
          target: this.#byId.get(id)!,
          k,
          natural: EDGE_LENGTH,
        });
      }
    }
    for (const body of this.#bodies) {
      const layer = layers.get(body.id) ?? 0;
      const k = SPRING_K / (layerCounts.get(layer) ?? 1);
      for (const g of grounds.get(body.id) ?? []) {
        const source = this.#byId.get(g);
        if (source === undefined || source.anchor) continue;
        const span = Math.max(1, layer - (layers.get(g) ?? 0));
        springs.push({ source, target: body, k, natural: span * EDGE_LENGTH });
      }
    }
    const bodies = this.#bodies;
    /** Hookean springs, equal and opposite on both ends; scaled by alpha
     * like the built-in forces so the equilibrium is alpha-invariant. */
    const springForce = (alpha: number): void => {
      for (const s of springs) {
        const dx = s.target.x! - s.source.x!;
        const dy = s.target.y! - s.source.y!;
        const length = Math.hypot(dx, dy) || 1;
        const magnitude = s.k * (length - s.natural) * alpha;
        const fx = (dx / length) * magnitude;
        const fy = (dy / length) * magnitude;
        s.source.vx = (s.source.vx ?? 0) + fx;
        s.source.vy = (s.source.vy ?? 0) + fy;
        s.target.vx = (s.target.vx ?? 0) - fx;
        s.target.vy = (s.target.vy ?? 0) - fy;
      }
    };
    /** Constant downstream gravity: the load the anchored spring chain
     * hangs against. The anchor itself is pinned and feels nothing. */
    const gravityForce = (alpha: number): void => {
      const g = GRAVITY * alpha * sign;
      for (const body of bodies) {
        if (horizontal) body.vx = (body.vx ?? 0) + g;
        else body.vy = (body.vy ?? 0) + g;
      }
    };
    const reheated = seeded;
    const packedRadius = Math.hypot(this.#size.width, this.#size.height) / 2 + COLLIDE_SLACK;
    this.#sim = forceSimulation<Body, SimulationLinkDatum<Body>>(
      anchorBody !== null ? [anchorBody, ...this.#bodies] : this.#bodies,
    )
      .force("spring", springForce)
      .force(
        "charge",
        forceManyBody<Body>()
          .strength((body) => (body.anchor ? 0 : REPULSION))
          .distanceMin(REPULSION_FLOOR)
          .distanceMax(REPULSION_RANGE),
      )
      .force(
        "collide",
        forceCollide<Body>((body) => (body.anchor ? 0 : packedRadius)).iterations(3),
      )
      .force("gravity", gravityForce)
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
      width: this.#size.width,
      height: this.#size.height,
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
