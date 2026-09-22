import {
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { quadtree, type QuadtreeLeaf } from "d3-quadtree";
import { assignLayers } from "refino";
import type { LayoutDirection } from "../../types";
import { LAYER_GAP, layeredLayout, resolveNodeSize } from "./engine";
import type {
  ForceTuning,
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
 * Overlap is prevented by exact axis-aligned rectangle separation (push
 * apart along the smaller overlap): the force vanishes whenever two
 * rectangles are separated, so it cannot fight the spring network at the
 * layout's natural spacing the way a covering-circle packing would —
 * adjacent layers in a vertical direction sit closer than one card
 * diagonal, and a circle large enough to guarantee rectangle separation
 * pushed them apart forever. Velocity decay bleeds kinetic energy off as
 * friction.
 *
 * Forces act at constant strength — there is no decaying alpha schedule.
 * A session runs until the layout is actually stable: every body's speed
 * stays under a threshold for a sustained run of ticks, which only a true
 * force balance sustains (a swing's turning point is quiet for one tick,
 * not thirty). Stopping is therefore decided by the physics, never by a
 * step count; the one exception is a far-off anti-hang tick guard that
 * normal relaxations never reach. An episode that relaxes far past its
 * budget runs down a settling ramp of progressively stronger friction,
 * which over-damps constrained shapes (deep merges into crowded layers
 * keep creeping and clipping contacts) until the stable stop is reached —
 * the ramp never stops anything by itself, it only makes rest reachable.
 * A drag holds its neighbourhood in real-time relaxation; once it settles
 * the physics sleeps, and the next pointer move wakes it again.
 *
 * Determinism: nodes are laid out in id-sorted array order and the
 * custom forces iterate their bodies and springs in construction
 * order, and the random source stays d3's fixed-seed LCG, so the same
 * input always converges to the same layout.
 */

/** Pair repulsion magnitude: the k in the k/d falloff. Overridable via
 * ForceTuning.repulsion. */
const DEFAULT_REPULSION = 80;
/** Inverse-square floor: below this center distance the push stops growing,
 * keeping near-contact motion orderly instead of divergent. */
const REPULSION_FLOOR = 160;
/** Repulsion cutoff: pair repulsion is a local spacing force (layer mates
 * and adjacent layers sit well inside this radius), not a system-spanning
 * load. Without the cutoff the far half of a long graph pushes on the
 * near half faster than gravity, compressing the chain against the anchor
 * and laterally buckling it. */
const REPULSION_RANGE = 500;
/** Constant downstream gravity every node feels along the display
 * direction. It loads the spring chain hanging from the anchor: a spring
 * near the anchor carries the pull of the whole downstream subtree, and
 * its stretch is load/k — so with the default gravity, layers fan out
 * gently with depth. Overridable via ForceTuning.gravity. */
const DEFAULT_GRAVITY = 2.635;
/** Hookean spring stiffness scale: each spring gets this divided by the
 * node count of the layer its downstream end sits in, so a wide layer
 * receives many softer springs while the total pull entering the layer
 * stays constant. Overridable via ForceTuning.spring. */
const DEFAULT_SPRING = 0.35;
/** Fraction of each body's velocity bled off every tick (friction);
 * passed straight to d3's velocityDecay, which decays velocities by this
 * factor. Overridable via ForceTuning.friction. */
const DEFAULT_FRICTION = 0.38;
/** Contact stiffness: an overlapping pair's velocity push per tick is the
 * overlap along the smaller axis times this, split over the pair. Stiff
 * enough that the equilibrium overlap against spring loads stays well
 * below a pixel, soft enough for the explicit integrator. */
const CONTACT_STRENGTH = 2;
/** Per-tick speed (px, any axis) below which a body counts as quiet.
 * Friction shrinks coasting velocity geometrically, and at a true force
 * balance the net force is float noise, so quiet is reachable. */
const STOP_SPEED = 0.01;
/** Consecutive quiet ticks required before the session counts as stable
 * and stops. A single quiet tick can be a swing's turning point; only a
 * sustained quiet run distinguishes a real equilibrium. */
const STABLE_TICKS = 30;
/** Offset that separates a new node from the exact centroid of its grounds
 * so coincident starts never happen; derived from the id's rank, hence
 * deterministic. */
const JOIN_OFFSET = 12;
/** Anti-hang guard, not an operating stop: normal relaxations end via the
 * stability criterion orders of magnitude earlier. */
const MAX_TICKS = 50_000;
/** Settling ramp: past this many ticks of one relaxation episode, friction
 * ramps up so the system over-damps and slides into the stable stop. Some
 * constrained shapes (deep merges into crowded layers) keep creeping and
 * clipping contacts for a very long time; without the ramp they would
 * need unpredictable relaxation budgets. The ramp never stops anything by
 * itself — it only makes rest reachable, the stability criterion still
 * decides. */
const SETTLE_BEGIN_TICKS = 5000;
const SETTLE_RAMP_TICKS = 10_000;
const SETTLE_FRICTION = 0.98;
/** Fixed-interval physics: one tick per this many ms of frame budget, so
 * the convergence path (and result) never depends on frame rate. */
const TICK_MS = 16;
/** Clamp for huge frame gaps (tab background, debugger pause). */
const MAX_DT = 48;

/** Built-in tuning defaults and persistence bounds; the canvas config
 * overrides the defaults through LayoutOptions.force. */
export const FORCE_TUNING_DEFAULT: ForceTuning = {
  gravity: DEFAULT_GRAVITY,
  friction: DEFAULT_FRICTION,
  repulsion: DEFAULT_REPULSION,
  spring: DEFAULT_SPRING,
};
export const FORCE_TUNING_MIN: ForceTuning = {
  gravity: 0,
  friction: 0,
  repulsion: 0,
  spring: 0,
};
export const FORCE_TUNING_MAX: ForceTuning = {
  gravity: 5,
  friction: 0.9,
  repulsion: 400,
  spring: 1,
};

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
  /** Consecutive ticks in which every body's speed stayed under
   * STOP_SPEED; stability = a sustained quiet run, not a single quiet
   * tick. */
  #quiet = 0;
  /** The configured (or default) friction the settling ramp starts from. */
  #friction = DEFAULT_FRICTION;
  /** The pinned virtual root, if the working set has real roots; exposed
   * read-only through anchorNode()/anchorEdges() for display. */
  #anchor: Body | null = null;
  /** The anchor's links to the working set's roots, fixed at construction. */
  #anchorLinks: readonly Readonly<{ source: string; target: string }>[] = [];

  constructor(nodes: readonly LayoutNode[], options: LayoutOptions) {
    this.#size = resolveNodeSize(options);
    const direction: LayoutDirection = options.direction;
    const horizontal = direction === "LR" || direction === "RL";
    const sign = direction === "LR" || direction === "TB" ? 1 : -1;
    // Tuning coefficients (canvas config overrides the built-in defaults).
    const gravity = options.force?.gravity ?? DEFAULT_GRAVITY;
    const friction = options.force?.friction ?? DEFAULT_FRICTION;
    this.#friction = friction;
    const repulsion = options.force?.repulsion ?? DEFAULT_REPULSION;
    const springK = options.force?.spring ?? DEFAULT_SPRING;
    // One grounds-layer pitch: the shared card dimension along the main
    // axis plus the common layer gap — the same pitch the layered layout
    // maps per layer, so both strategies space layers identically and
    // node resizing re-spaces the force graph too.
    const pitch =
      (horizontal ? this.#size.width : this.#size.height) + (options.layerGap ?? LAYER_GAP);
    // Fallback seed: layered positions are deterministic, a natural starting
    // shape, and already oriented along the display direction, so the first
    // force session starts from a readable layout. A carried-over seed
    // (previous session) wins per node.
    const layered = new Map(
      layeredLayout(nodes, direction, this.#size, options.layerGap).map((n) => [n.id, n] as const),
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
    // Stiffness shares: a spring entering layer L gets the spring stiffness split
    // across that layer's node count.
    const layerCounts = new Map<number, number>();
    for (const id of ids) {
      const layer = layers.get(id) ?? 0;
      layerCounts.set(layer, (layerCounts.get(layer) ?? 0) + 1);
    }
    // The virtual root: pinned one pitch upstream of the roots' centroid,
    // so every root spring starts near its rest length and the anchor
    // keeps the carried-over graph where it is. A carried seed carries the
    // anchor's own position too (under the anchor id in the seed map):
    // re-deriving it would re-place the anchor relative to roots that
    // have stretched downstream since, and the whole graph would slide
    // a little further on every session — a downstream ratchet.
    // Roots are nodes with no ground inside the working set.
    const present = new Set(ids);
    const rootIds = ids.filter((id) => !(grounds.get(id) ?? []).some((g) => present.has(g)));
    let anchorBody: Body | null = null;
    if (rootIds.length > 0) {
      const carriedAnchor = carried?.get(ANCHOR_ID);
      if (carriedAnchor !== undefined) {
        anchorBody = {
          id: ANCHOR_ID,
          anchor: true,
          x: carriedAnchor.x,
          y: carriedAnchor.y,
          fx: carriedAnchor.x,
          fy: carriedAnchor.y,
        };
      } else {
        let ax = 0;
        let ay = 0;
        for (const id of rootIds) {
          ax += start.get(id)!.x;
          ay += start.get(id)!.y;
        }
        ax /= rootIds.length;
        ay /= rootIds.length;
        if (horizontal) ax -= sign * pitch;
        else ay -= sign * pitch;
        anchorBody = { id: ANCHOR_ID, anchor: true, x: ax, y: ay, fx: ax, fy: ay };
      }
      this.#anchor = anchorBody;
      this.#anchorLinks = rootIds.map((id) => ({ source: ANCHOR_ID, target: id }));
    }
    // Grounds springs, plus one anchor spring per root (span 1).
    const springs: Spring[] = [];
    if (anchorBody !== null) {
      const k = springK / (layerCounts.get(0) ?? 1);
      for (const id of rootIds) {
        springs.push({
          source: anchorBody,
          target: this.#byId.get(id)!,
          k,
          natural: pitch,
        });
      }
    }
    for (const body of this.#bodies) {
      const layer = layers.get(body.id) ?? 0;
      const k = springK / (layerCounts.get(layer) ?? 1);
      for (const g of grounds.get(body.id) ?? []) {
        const source = this.#byId.get(g);
        if (source === undefined || source.anchor) continue;
        const span = Math.max(1, layer - (layers.get(g) ?? 0));
        springs.push({ source, target: body, k, natural: span * pitch });
      }
    }
    const bodies = this.#bodies;
    /** Hookean springs, equal and opposite on both ends. */
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
      const g = gravity * alpha * sign;
      for (const body of bodies) {
        if (horizontal) body.vx = (body.vx ?? 0) + g;
        else body.vy = (body.vy ?? 0) + g;
      }
    };
    const width = this.#size.width;
    const height = this.#size.height;
    const bodyX = (body: Body): number => body.x ?? 0;
    const bodyY = (body: Body): number => body.y ?? 0;
    /** Exact pairwise repulsion, replacing d3's Barnes-Hut manyBody: the
     * approximation computes each body's push from cluster aggregates, and
     * the resulting forces are not exactly symmetric — the tiny residual
     * never balances, and with no alpha schedule to freeze it, the whole
     * graph drifts forever (a ~0.03px/tick limit cycle in practice). This
     * walks the same quadtree but applies the exact central force to each
     * pair, so internal forces cancel pairwise and friction can actually
     * bring the layout to rest. Same falloff and limits as before: k/d
     * with the d3 distanceMin softening inside REPULSION_FLOOR and a hard
     * cutoff at REPULSION_RANGE. */
    const repulsionForce = (alpha: number): void => {
      const range2 = REPULSION_RANGE * REPULSION_RANGE;
      const floor2 = REPULSION_FLOOR * REPULSION_FLOOR;
      const tree = quadtree<Body>(bodies, bodyX, bodyY);
      for (const body of bodies) {
        if (body.anchor) continue;
        const bx = bodyX(body);
        const by = bodyY(body);
        tree.visit((node, x0, y0, x1, y1) => {
          // Prune subtrees whose extent cannot reach the cutoff radius.
          if (
            x0 > bx + REPULSION_RANGE ||
            x1 < bx - REPULSION_RANGE ||
            y0 > by + REPULSION_RANGE ||
            y1 < by - REPULSION_RANGE
          ) {
            return true;
          }
          if (!Array.isArray(node)) {
            for (
              let leaf: QuadtreeLeaf<Body> | undefined = node as QuadtreeLeaf<Body>;
              leaf !== undefined;
              leaf = leaf.next
            ) {
              const other = leaf.data;
              if (other === body || other.anchor) continue;
              const dx = bodyX(other) - bx;
              const dy = bodyY(other) - by;
              let l = dx * dx + dy * dy;
              if (l > range2 || l === 0) continue;
              if (l < floor2) l = Math.sqrt(floor2 * l);
              const w = (-repulsion * alpha) / l;
              body.vx = (body.vx ?? 0) + dx * w;
              body.vy = (body.vy ?? 0) + dy * w;
            }
          }
          return false;
        });
      }
    };
    /** Exact axis-aligned rectangle separation: an overlapping pair pushes
     * apart along the axis with the smaller overlap, and a separated pair
     * feels nothing — packing cannot fight the springs at the layout's
     * natural spacing the way a covering-circle packing would (adjacent
     * layers in a vertical direction sit closer than one card diagonal,
     * and a circle radius large enough to guarantee rectangle separation
     * pushed them apart forever, which no decaying schedule is around
     * anymore to freeze). A full-overlap push fully separates the pair,
     * so the double visit of each pair is self-cancelling. */
    const contactForce = (): void => {
      const tree = quadtree<Body>(bodies, bodyX, bodyY);
      for (const body of bodies) {
        const bx = bodyX(body);
        const by = bodyY(body);
        tree.visit((node, x0, y0, x1, y1) => {
          // Prune subtrees whose extent cannot reach this card.
          if (x0 > bx + width || x1 < bx - width || y0 > by + height || y1 < by - height) {
            return true;
          }
          if (!Array.isArray(node)) {
            for (
              let leaf: QuadtreeLeaf<Body> | undefined = node as QuadtreeLeaf<Body>;
              leaf !== undefined;
              leaf = leaf.next
            ) {
              const other = leaf.data;
              if (other === body) continue;
              const dx = bodyX(other) - bx;
              const dy = bodyY(other) - by;
              const overX = width - Math.abs(dx);
              const overY = height - Math.abs(dy);
              if (overX <= 0 || overY <= 0) continue;
              // Contact acts as a stiff velocity spring along the axis with
              // the smaller overlap, split over the pair. Like every other
              // force it goes through velocity, so friction can dissipate
              // it: contact and springs balance at a sub-pixel overlap and
              // the layout truly rests instead of projecting in and out of
              // the overlap forever.
              const w = CONTACT_STRENGTH * 0.5;
              if (overX < overY) {
                const push = dx < 0 ? -overX : overX;
                if (!body.anchor) body.vx = (body.vx ?? 0) - push * w;
                if (!other.anchor) other.vx = (other.vx ?? 0) + push * w;
              } else {
                const push = dy < 0 ? -overY : overY;
                if (!body.anchor) body.vy = (body.vy ?? 0) - push * w;
                if (!other.anchor) other.vy = (other.vy ?? 0) + push * w;
              }
            }
          }
          return false;
        });
      }
    };
    this.#sim = forceSimulation<Body, SimulationLinkDatum<Body>>(
      anchorBody !== null ? [anchorBody, ...this.#bodies] : this.#bodies,
    )
      .force("spring", springForce)
      .force("charge", repulsionForce)
      .force("collide", contactForce)
      .force("gravity", gravityForce)
      // No alpha schedule: alpha stays 1 forever, forces act at constant
      // strength, and stopping is decided by the stability criterion.
      .alphaDecay(0)
      .velocityDecay(friction)
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

  /** The pinned virtual root, or null when the working set has no roots.
   * Display-only: excluded from positions() on purpose, so the camera
   * bounds and the drag/selection addressing never see it. */
  anchorNode(): LaidOutNode | null {
    const anchor = this.#anchor;
    if (anchor === null) return null;
    return {
      id: anchor.id,
      x: anchor.x ?? 0,
      y: anchor.y ?? 0,
      width: this.#size.width,
      height: this.#size.height,
    };
  }

  /** The anchor's links to the working set's roots. */
  anchorEdges(): readonly Readonly<{ source: string; target: string }>[] {
    return this.#anchorLinks;
  }

  step(dtMs: number): readonly LaidOutNode[] {
    if (!this.#animating) return this.positions();
    // Fixed physics regardless of frame timing: accumulate clamped slices
    // so the convergence path (and result) never depends on frame rate.
    let budget = Math.min(Math.max(dtMs, 0), MAX_DT);
    while (budget > 0 && this.#animating) {
      // The settling ramp: once an episode has relaxed far past the normal
      // budget, over-damp the system so rest becomes reachable for
      // constrained shapes that keep creeping and clipping contacts.
      if (this.#ticks > SETTLE_BEGIN_TICKS) {
        const ramp = Math.min(1, (this.#ticks - SETTLE_BEGIN_TICKS) / SETTLE_RAMP_TICKS);
        this.#sim.velocityDecay(this.#friction + (SETTLE_FRICTION - this.#friction) * ramp);
      }
      this.#sim.tick();
      this.#ticks += 1;
      budget -= TICK_MS;
      // Stability decides the stop, never the step count: a sustained run
      // of quiet ticks means the forces have actually balanced (a swing's
      // turning point is quiet for one tick, not thirty). Every force is
      // velocity-based and friction is dissipative, so quiet is reachable;
      // the pinned node holds the relaxation open while its neighbourhood
      // keeps moving — once everything settles the session sleeps until
      // the next drag event revives it.
      let maxSpeed = 0;
      for (const body of this.#bodies) {
        maxSpeed = Math.max(maxSpeed, Math.abs(body.vx ?? 0), Math.abs(body.vy ?? 0));
      }
      if (maxSpeed < STOP_SPEED) this.#quiet += 1;
      else this.#quiet = 0;
      if (this.#quiet >= STABLE_TICKS || this.#ticks >= MAX_TICKS) {
        this.#animating = false;
      }
    }
    return this.positions();
  }

  /** Pins the node at the pointer position and keeps the neighbourhood
   * relaxing at full force: the drag owns the session's life, and each
   * pointer move revives it after a settled (sleeping) hold. */
  fix(id: string, x: number, y: number): void {
    const body = this.#byId.get(id);
    if (body === undefined) return;
    body.fx = x;
    body.fy = y;
    this.#animating = true;
    this.#quiet = 0;
    this.#ticks = 0;
  }

  /** Releases the node from the pointer: the forces take it back and the
   * session relaxes until actually stable. */
  release(id: string): void {
    const body = this.#byId.get(id);
    if (body !== undefined) {
      body.fx = undefined;
      body.fy = undefined;
    }
    this.#animating = true;
    this.#quiet = 0;
    this.#ticks = 0;
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
