import type { LayoutDirection } from "../../types";
import { CROSS_GAP, LAYER_GAP, displayLayers, layeredLayout, resolveNodeSize } from "./engine";
import type {
  LaidOutNode,
  LayoutNode,
  LayoutOptions,
  LayoutSession,
  LayoutStrategy,
} from "./types";

/**
 * Rail layout (ui DESIGN.md, "布局"): layered main axis, force-relaxed
 * cross axis.
 *
 * Layers come from the same grounds longest-path layering as the layered
 * layout, with premises on their display layers (just upstream of the
 * shallowest decision they support, `engine.displayLayers`), and every
 * node is pinned to its layer's line on the main axis —
 * the line positions are the layered mapping exactly (one pitch per
 * layer, signed by the display direction). The cross axis is a one-
 * dimensional relaxation: each node feels a Hookean pull toward the mean
 * cross position of its grounds (a family stays centered on its upstream,
 * and multi-ground merges settle between their anchors), a premise pulls
 * toward the mean cross position of its dependents (it clusters beside
 * the family it supports), remaining roots relax
 * toward their layered snapshot slot, and an order-preserving sweep
 * enforces an exact minimum gap between same-layer neighbors, re-centering
 * compressed families around their anchors. The session stops on the same
 * sustained-quiet criterion as the force layout — a genuinely converged
 * relaxation, never a step count. The result reads like the layered
 * layout, but layer order is a live equilibrium instead of a snapshot:
 * dragging a node slides its neighbourhood along the rails, and
 * working-set changes nudge the layout instead of re-stacking it.
 *
 * Determinism: bodies are built and iterated in id-sorted order, collision
 * sweeps walk each layer's bodies in cross order, and the initial cross
 * positions come from the layered layout (id-ordered by construction), so
 * the same input always converges to the same layout.
 */

/** Fraction of the distance to a body's anchor that one tick closes. */
const RATE = 0.2;
/** Per-tick cross displacement below which the session counts as quiet. */
const STOP_DELTA = 0.01;
/** Consecutive quiet ticks required before the session counts as stable. */
const STABLE_TICKS = 30;
/** Anti-hang guard, far past any normal relaxation. */
const MAX_TICKS = 50_000;
/** Fixed-interval physics, as in the force layout. */
const TICK_MS = 16;
const MAX_DT = 48;

/** One relaxing body: a node pinned to its layer line, free on the cross
 * axis. `main` is the fixed line coordinate, `cross` the live coordinate. */
interface Body {
  id: string;
  layer: number;
  main: number;
  cross: number;
  home: number;
  /** Cross coordinate pinned by an active drag; null when free. */
  fixed: number | null;
  /** Premise flag: premises anchor to their dependents' mean instead of
   * their home slot (root decisions must not chase their children). */
  premise: boolean;
  grounds: readonly string[];
  /** In-set dependents, filled once all bodies exist; a premise's cross
   * anchor (the family it supports) reads this. */
  children: Body[];
}

class RailSession implements LayoutSession {
  readonly #bodies: Body[] = [];
  readonly #byId = new Map<string, Body>();
  /** Same-layer bodies grouped per layer, walked in cross order by the
   * collision sweep. */
  readonly #layers: Body[][] = [];
  /** The card geometry this session spaces and stamps. */
  readonly #size: { width: number; height: number };
  readonly #horizontal: boolean;
  #ticks = 0;
  #animating = true;
  #quiet = 0;

  constructor(nodes: readonly LayoutNode[], options: LayoutOptions) {
    this.#size = resolveNodeSize(options);
    const direction: LayoutDirection = options.direction;
    this.#horizontal = direction === "LR" || direction === "RL";
    const sign = direction === "LR" || direction === "TB" ? 1 : -1;
    const layerGap = options.layerGap ?? LAYER_GAP;
    const { width, height } = this.#size;
    const pitch = (this.#horizontal ? width : height) + layerGap;
    // Layering and the snapshot cross order: the layered layout is the
    // deterministic starting shape (its family-centering order is the
    // equilibrium the relaxation starts from). Premises take their display
    // layers, so their rail is the line just upstream of the shallowest
    // decision they support.
    const layers = displayLayers([...nodes].sort((a, b) => (a.id < b.id ? -1 : 1)));
    const snapshot = new Map(
      layeredLayout(nodes, direction, this.#size, layerGap).map((n) => [n.id, n] as const),
    );
    const carried = options.seed;
    const grounds = new Map(nodes.map((n) => [n.id, n.grounds ?? []] as const));
    const premiseIds = new Set(nodes.filter((n) => n.premise ?? false).map((n) => n.id));
    const ids = [...snapshot.keys()].sort();
    for (const id of ids) {
      const snap = snapshot.get(id)!;
      // The seed (a previous rail session's nodes, or a force session's)
      // carries only the cross coordinate: the main axis is re-derived
      // from the fresh layering, so working-set changes keep the layer
      // lines exact while known nodes keep their order along them.
      const cross = this.#horizontal
        ? (carried?.get(id)?.y ?? snap.y)
        : (carried?.get(id)?.x ?? snap.x);
      const main = layers.get(id)! * pitch;
      this.#bodies.push({
        id,
        layer: layers.get(id)!,
        main: sign > 0 ? main : -main - (this.#horizontal ? width : height),
        cross,
        home: this.#horizontal ? snap.y : snap.x,
        fixed: null,
        premise: premiseIds.has(id),
        grounds: grounds.get(id) ?? [],
        children: [],
      });
    }
    for (const body of this.#bodies) this.#byId.set(body.id, body);
    for (const body of this.#bodies) {
      for (const g of body.grounds) {
        const source = this.#byId.get(g);
        if (source !== undefined) source.children.push(body);
      }
    }
    const buckets = new Map<number, Body[]>();
    for (const body of this.#bodies) {
      const bucket = buckets.get(body.layer);
      if (bucket) bucket.push(body);
      else buckets.set(body.layer, [body]);
    }
    this.#layers = [...buckets.keys()].sort((a, b) => a - b).map((l) => buckets.get(l)!);
    if (this.#bodies.length <= 1) this.#animating = false;
  }

  get animating(): boolean {
    return this.#animating;
  }

  positions(): readonly LaidOutNode[] {
    return this.#bodies.map((body) =>
      this.#horizontal
        ? {
            id: body.id,
            x: body.main,
            y: body.cross,
            width: this.#size.width,
            height: this.#size.height,
          }
        : {
            id: body.id,
            x: body.cross,
            y: body.main,
            width: this.#size.width,
            height: this.#size.height,
          },
    );
  }

  step(dtMs: number): readonly LaidOutNode[] {
    if (!this.#animating) return this.positions();
    let budget = Math.min(Math.max(dtMs, 0), MAX_DT);
    while (budget > 0 && this.#animating) {
      const moved = this.#tick();
      this.#ticks += 1;
      budget -= TICK_MS;
      // Stability = a sustained run of near-zero displacements: the cross
      // relaxation has actually converged (a swing's turning point is
      // quiet for one tick, not thirty).
      if (moved < STOP_DELTA) this.#quiet += 1;
      else this.#quiet = 0;
      if (this.#quiet >= STABLE_TICKS || this.#ticks >= MAX_TICKS) this.#animating = false;
    }
    return this.positions();
  }

  /** One relaxation tick: every body steps toward its anchor (the mean
   * cross position of its grounds; a premise toward the mean of its
   * dependents — it follows the family it supports; other roots step
   * toward their layered home
   * slot), then each layer resolves overlaps by an order-preserving
   * forward sweep that enforces the exact minimum gap, re-centered so a
   * compressed family stays centered on its anchors. Returns the largest
   * displacement this tick produced. */
  #tick(): number {
    const byId = this.#byId;
    const desired = new Map<Body, number>();
    for (const body of this.#bodies) {
      if (body.fixed !== null) {
        desired.set(body, body.fixed);
        continue;
      }
      const anchors = body.grounds
        .map((g) => byId.get(g))
        .filter((b): b is Body => b !== undefined);
      let target: number;
      if (anchors.length > 0) {
        target = anchors.reduce((sum, a) => sum + a.cross, 0) / anchors.length;
      } else if (body.premise && body.children.length > 0) {
        target = body.children.reduce((sum, c) => sum + c.cross, 0) / body.children.length;
      } else {
        target = body.home;
      }
      desired.set(body, body.cross + RATE * (target - body.cross));
    }
    let moved = 0;
    const minDist = (this.#horizontal ? this.#size.height : this.#size.width) + CROSS_GAP;
    for (const bucket of this.#layers) {
      const sorted = [...bucket].sort((a, b) => desired.get(a)! - desired.get(b)!);
      // Forward sweep: each body takes its desired slot unless the previous
      // body's slot plus the minimum gap is past it. A dragged (fixed)
      // body is a wall: free bodies slide against it, never through it.
      const slots: number[] = [];
      for (let i = 0; i < sorted.length; i++) {
        const body = sorted[i]!;
        const want = desired.get(body)!;
        slots.push(i === 0 || body.fixed !== null ? want : Math.max(want, slots[i - 1]! + minDist));
      }
      // Recenter contiguous compressed runs around their desired mean, so
      // a family pulled onto one spot spreads symmetrically instead of
      // stacking one-sided above its anchor. Runs are maximal stretches
      // where the sweep actually pushed bodies past their desire.
      let start = 0;
      while (start < sorted.length) {
        let end = start;
        while (end + 1 < sorted.length && slots[end + 1]! > desired.get(sorted[end + 1]!)! + 1e-9) {
          end += 1;
        }
        if (end > start) {
          let shift = 0;
          for (let i = start; i <= end; i++) {
            shift += desired.get(sorted[i]!)! - slots[i]!;
          }
          shift /= end - start + 1;
          // Shifting down must not collide with the body before the run.
          const lowerBound = start === 0 ? -Infinity : slots[start - 1]! + minDist;
          shift = Math.max(shift, lowerBound - slots[start]!);
          for (let i = start; i <= end; i++) slots[i] = slots[i]! + shift;
        }
        start = end + 1;
      }
      for (let i = 0; i < sorted.length; i++) {
        const body = sorted[i]!;
        const slot = slots[i]!;
        moved = Math.max(moved, Math.abs(slot - body.cross));
        body.cross = slot;
      }
    }
    return moved;
  }

  /** Pins the node's cross coordinate at the pointer, projected onto the
   * layer line — the main coordinate stays the layer's, so a drag can only
   * slide the node along its rail — and keeps the neighbourhood relaxing. */
  fix(id: string, x: number, y: number): void {
    const body = this.#byId.get(id);
    if (body === undefined) return;
    body.fixed = this.#horizontal ? y : x;
    this.#animating = true;
    this.#quiet = 0;
    this.#ticks = 0;
  }

  release(id: string): void {
    const body = this.#byId.get(id);
    if (body !== undefined) body.fixed = null;
    this.#animating = true;
    this.#quiet = 0;
    this.#ticks = 0;
  }

  dispose(): void {
    this.#animating = false;
  }
}

/** Rail strategy: layered lines with a force-relaxed cross axis. */
export const railStrategy: LayoutStrategy = {
  id: "rail",
  createSession(nodes: readonly LayoutNode[], options: LayoutOptions): LayoutSession {
    return new RailSession(nodes, options);
  },
};
