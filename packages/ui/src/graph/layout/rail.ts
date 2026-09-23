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
 * enforces an exact minimum gap between same-layer free neighbors,
 * re-centering compressed families around their anchors. The session
 * stops on the same sustained-quiet criterion as the force layout — a
 * genuinely converged relaxation, never a step count. The result reads
 * like the layered layout, but layer order is a live equilibrium instead
 * of a snapshot: dragging a node slides it along its rail while its mates
 * dodge a soft repulsion and spring back on release, and working-set
 * changes nudge the layout instead of re-swimming it.
 *
 * Determinism: bodies are built and iterated in id-sorted order, collision
 * sweeps walk each layer's bodies in desired order, and the initial cross
 * positions come from the layered layout (id-ordered by construction), so
 * the same input always converges to the same layout.
 */

/** Fraction of the distance to a body's anchor that one tick closes. */
const RATE = 0.2;
/** Within this distance of its anchor a body's desired cross snaps to the
 * anchor exactly, so bodies sharing an anchor tie *exactly* and the sweep
 * falls back to the layered home order — drags can never permute the row
 * through float dust in the integrator. */
const DESIRED_SNAP = 0.5;
/** Fraction of the distance to the swept slot a body's cross closes per
 * tick. Blending (instead of jumping to the slot) turns a release after a
 * hold into a fast glide rather than a snap. */
const SWEEP_RATE = 0.5;
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
 * axis. `main` is the fixed line coordinate, `cross` the live coordinate,
 * `desired` the integrated relaxation goal the collision sweep works from
 * (it converges toward the anchor whether or not the sweep currently
 * clamps the body, so a body squeezed aside by a drag always slides back
 * home once the clamp lifts — a cross-derived goal would freeze against
 * the clamp and jam the row permanently). */
interface Body {
  id: string;
  layer: number;
  main: number;
  cross: number;
  desired: number;
  /** Layered snapshot slot; the sweep's tie-break order when bodies'
   * desired crosses coincide (equal-anchor families), so the row's slot
   * assignment always falls back to the layered arrangement. */
  home: number;
  /** Cross coordinate pinned by an active drag; null when free. A dragged
   * body stands outside the collision sweep: it takes the pointer cross
   * exactly and only repels its layer mates — never displaced, a wall to
   * nobody. */
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
        desired: cross,
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

  /** One relaxation tick. Every free body integrates its desired cross
   * toward its anchor (the mean cross position of its grounds; a premise
   * toward the mean of its dependents — it follows the family it supports;
   * other roots toward their layered home slot), the sweep then parts the
   * free bodies of each layer into a minimum-gap arrangement in desired
   * order (ties in the layered home order) and their crosses glide toward
   * it, and finally a dragged body — outside the sweep entirely — takes
   * the pointer cross and its layer mates are projected out of the
   * rectangle-and-gap zone around it: pure repulsion, no wall. Returns
   * the largest displacement this tick produced. */
  #tick(): number {
    const byId = this.#byId;
    let dragged: Body | null = null;
    for (const body of this.#bodies) {
      if (body.fixed !== null) {
        dragged = body;
        body.desired = body.fixed;
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
      // The goal integrates toward the target independently of `cross`:
      // a body the sweep currently clamps keeps converging, so once the
      // clamp lifts (drag moved on, released) it slides home instead of
      // freezing in a squeezed-aside permutation of the row.
      const next = body.desired + RATE * (target - body.desired);
      body.desired = Math.abs(target - next) < DESIRED_SNAP ? target : next;
    }
    let moved = 0;
    const minDist = (this.#horizontal ? this.#size.height : this.#size.width) + CROSS_GAP;
    for (const bucket of this.#layers) {
      const sorted = bucket
        .filter((body) => body.fixed === null)
        .sort((a, b) => a.desired - b.desired || a.home - b.home || (a.id < b.id ? -1 : 1));
      // Forward sweep: each body takes its desired slot unless the previous
      // body's slot plus the minimum gap is past it.
      const slots: number[] = [];
      for (let i = 0; i < sorted.length; i++) {
        const want = sorted[i]!.desired;
        slots.push(i === 0 ? want : Math.max(want, slots[i - 1]! + minDist));
      }
      // Recenter contiguous compressed runs around their desired mean, so
      // a family pulled onto one spot spreads symmetrically instead of
      // stacking one-sided above its anchor. Runs are maximal stretches
      // where the sweep actually pushed bodies past their desire.
      let start = 0;
      while (start < sorted.length) {
        let end = start;
        while (end + 1 < sorted.length && slots[end + 1]! > sorted[end + 1]!.desired + 1e-9) {
          end += 1;
        }
        if (end > start) {
          let shift = 0;
          for (let i = start; i <= end; i++) {
            shift += sorted[i]!.desired - slots[i]!;
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
        const next = body.cross + SWEEP_RATE * (slots[i]! - body.cross);
        moved = Math.max(moved, Math.abs(next - body.cross));
        body.cross = next;
      }
    }
    if (dragged !== null) {
      moved = Math.max(moved, Math.abs(dragged.fixed! - dragged.cross));
      dragged.cross = dragged.fixed!;
      // Soft repulsion, same layer only (other layers' lines are a full
      // pitch away, never within a card of it): mates are projected out of
      // the dragged card's rectangle-plus-gap zone, nearest first, each
      // chaining its own side outward. A pure positional projection — it
      // never touches the desired goals or the sweep order, so nothing
      // sticks: the anchors pull every mate back once the drag moves on
      // or releases.
      const at = dragged.fixed!;
      const mates = this.#bodies
        .filter((body) => body !== dragged && body.layer === dragged.layer)
        .sort((a, b) => a.cross - b.cross);
      // Mates below the pointer, nearest first, chained outward downward.
      let upper: number | null = null;
      let i = mates.length;
      while (i > 0 && mates[i - 1]!.cross >= at) i -= 1;
      for (; i > 0; i -= 1) {
        const mate = mates[i - 1]!;
        const pos = Math.min(mate.cross, (upper ?? at) - minDist);
        moved = Math.max(moved, Math.abs(pos - mate.cross));
        mate.cross = pos;
        upper = pos;
      }
      // Mates above the pointer, nearest first, chained outward upward.
      let lower: number | null = null;
      for (const mate of mates) {
        if (mate.cross < at) continue;
        const pos = Math.max(mate.cross, (lower ?? at) + minDist);
        moved = Math.max(moved, Math.abs(pos - mate.cross));
        mate.cross = pos;
        lower = pos;
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
