import type { LayoutDirection } from "../../types";

/**
 * Incremental layered layout (ui README, "布局：增量分层").
 *
 * Layers follow the grounds edges; the chosen direction only maps canonical
 * (layer, order) coordinates to x/y, so switching direction never re-lays
 * out. Virtual coordinates are stable: once a node is placed it keeps its
 * (layer, order) until it leaves the working set, and re-entering nodes
 * restore their previous position. New nodes attach relative to their
 * already-placed neighbors — a node with placed grounds sits one layer below
 * the deepest of them, a node pulled in as a ground sits one layer above its
 * shallowest placed dependent (clamped at 0) — and take the nearest free
 * slot in their layer's order, so nothing already placed ever moves.
 * Disjoint additions have no placed neighbor to attach to and are laid out
 * as independent components below the existing content.
 *
 * The result is a deterministic function of the current placements and the
 * incoming working set (ties ordered by id); it is not path-independent —
 * that is the price of coordinate stability.
 */

/** Minimal read-only node shape the layout needs. */
export interface LayoutNode {
  id: string;
  grounds?: readonly string[];
}

/** Mapped node geometry in virtual space. */
export interface LaidOutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const NODE_WIDTH = 150;
const NODE_HEIGHT = 44;
const LAYER_GAP = 90;
const CROSS_GAP = 16;
/** Empty rows between the existing content and an independent component. */
const COMPONENT_GAP = 4;

interface Placement {
  layer: number;
  order: number;
}

export class IncrementalLayout {
  #placed = new Map<string, Placement>();
  /** Positions of nodes that left the working set, restored on re-entry. */
  #retired = new Map<string, Placement>();
  /** Layer → orders in use; the collision index for new placements. */
  #occupied = new Map<number, Set<number>>();
  #nodes = new Map<string, LayoutNode>();

  /**
   * Absorbs a working-set snapshot and returns the mapped geometry for it.
   * Placement state persists across calls; passing the same nodes again
   * only re-applies the direction mapping.
   */
  sync(nodes: readonly LayoutNode[], direction: LayoutDirection): LaidOutNode[] {
    this.#nodes = new Map(nodes.map((node) => [node.id, node] as const));
    const ids = new Set(this.#nodes.keys());

    // Nodes that left keep their slot in #retired for a cheap restore.
    for (const [id, placement] of this.#placed) {
      if (!ids.has(id)) {
        this.#placed.delete(id);
        this.#occupied.get(placement.layer)?.delete(placement.order);
        this.#retired.set(id, placement);
      }
    }
    for (const [id, placement] of this.#retired) {
      if (ids.has(id)) {
        this.#retired.delete(id);
        this.#place(id, placement);
      }
    }

    const dependents = new Map<string, string[]>();
    for (const node of this.#nodes.values()) {
      for (const ground of node.grounds ?? []) {
        if (!ids.has(ground)) continue;
        const list = dependents.get(ground);
        if (list) list.push(node.id);
        else dependents.set(ground, [node.id]);
      }
    }

    const pending = [...ids].filter((id) => !this.#placed.has(id)).sort();
    this.#attachPending(pending, dependents);
    this.#placeComponents(pending);

    const horizontal = direction === "LR" || direction === "RL";
    const result: LaidOutNode[] = [];
    for (const [id] of this.#nodes) {
      const placement = this.#placed.get(id)!;
      const main =
        placement.layer * (horizontal ? NODE_WIDTH + LAYER_GAP : NODE_HEIGHT + LAYER_GAP);
      const cross =
        placement.order * (horizontal ? NODE_HEIGHT + CROSS_GAP : NODE_WIDTH + CROSS_GAP);
      const [x, y] =
        direction === "LR"
          ? [main, cross]
          : direction === "RL"
            ? [-main - NODE_WIDTH, cross]
            : direction === "TB"
              ? [cross, main]
              : [cross, -main - NODE_HEIGHT];
      result.push({ id, x, y, width: NODE_WIDTH, height: NODE_HEIGHT });
    }
    return result;
  }

  /** Places every pending node that has a placed neighbor, in rounds so
   * chains entering together resolve. Unattached leftovers are independent
   * components. */
  #attachPending(pending: string[], dependents: ReadonlyMap<string, string[]>): void {
    const left = new Set(pending);
    let progressed = true;
    while (left.size > 0 && progressed) {
      progressed = false;
      for (const id of [...left].sort()) {
        const node = this.#nodes.get(id)!;
        const grounds = (node.grounds ?? []).filter((g) => this.#placed.has(g));
        if (grounds.length > 0) {
          let layer = 0;
          let orderSum = 0;
          for (const ground of grounds) {
            const placement = this.#placed.get(ground)!;
            layer = Math.max(layer, placement.layer + 1);
            orderSum += placement.order;
          }
          this.#place(id, { layer, order: this.#freeOrder(layer, orderSum / grounds.length) });
        } else {
          const deps = (dependents.get(id) ?? []).filter((d) => this.#placed.has(d));
          if (deps.length === 0) continue;
          // Layers may go negative: a predecessor chain pulled in above a
          // node placed at layer 0 keeps its layered shape instead of being
          // crushed into one layer (stability forbids shifting the placed
          // side down).
          let layer = Number.POSITIVE_INFINITY;
          let orderSum = 0;
          for (const dependent of deps) {
            const placement = this.#placed.get(dependent)!;
            layer = Math.min(layer, placement.layer);
            orderSum += placement.order;
          }
          layer -= 1;
          this.#place(id, { layer, order: this.#freeOrder(layer, orderSum / deps.length) });
        }
        left.delete(id);
        progressed = true;
      }
    }
    pending.length = 0;
    pending.push(...[...left].sort());
  }

  /** Lays out each still-unplaced connected group as an independent
   * component below the existing content (README: 无重叠则作为独立分量排布). */
  #placeComponents(pending: string[]): void {
    const pendingSet = new Set(pending);
    const groundsIn = new Map<string, string[]>();
    for (const id of pending) {
      const node = this.#nodes.get(id)!;
      groundsIn.set(
        id,
        (node.grounds ?? []).filter((g) => pendingSet.has(g)),
      );
    }
    // Dependents within the pending set (not covered by the sync-level index,
    // which only tracks placed neighbors).
    const depsIn = new Map<string, string[]>();
    for (const [ground, list] of groundsIn) {
      for (const g of list) {
        const entry = depsIn.get(g);
        if (entry) entry.push(ground);
        else depsIn.set(g, [ground]);
      }
    }

    const visited = new Set<string>();
    for (const root of pending) {
      if (visited.has(root)) continue;
      // Collect the component via BFS over grounds + dependents.
      const component = [root];
      visited.add(root);
      for (let head = 0; head < component.length; head++) {
        const id = component[head]!;
        for (const neighbor of [...(groundsIn.get(id) ?? []), ...(depsIn.get(id) ?? [])]) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            component.push(neighbor);
          }
        }
      }
      this.#placeComponent(component.sort(), groundsIn);
    }
  }

  /** Longest-path layering inside the component, BFS-derived order per
   * layer, then an offset below everything already placed. */
  #placeComponent(component: readonly string[], groundsIn: ReadonlyMap<string, string[]>): void {
    const layers = new Map<string, number>();
    let progressed = true;
    while (layers.size < component.length && progressed) {
      progressed = false;
      for (const id of component) {
        if (layers.has(id)) continue;
        const grounds = (groundsIn.get(id) ?? []).filter((g) => layers.has(g));
        if ((groundsIn.get(id) ?? []).length > grounds.length) continue;
        let layer = 0;
        for (const g of grounds) layer = Math.max(layer, layers.get(g)! + 1);
        layers.set(id, layer);
        progressed = true;
      }
    }

    let orderBase = COMPONENT_GAP;
    for (const placement of this.#placed.values()) {
      orderBase = Math.max(orderBase, placement.order + 1 + COMPONENT_GAP);
    }
    for (const placement of this.#retired.values()) {
      // Keep the region stable across churn: retired slots still reserve it.
      orderBase = Math.max(orderBase, placement.order + 1 + COMPONENT_GAP);
    }

    const byLayer = new Map<number, string[]>();
    for (const id of component) {
      const layer = layers.get(id)!;
      const bucket = byLayer.get(layer);
      if (bucket) bucket.push(id);
      else byLayer.set(layer, [id]);
    }
    // Orders are component-global and strictly increasing: buckets are
    // sorted by their parents' orders (min ground order, then id) so
    // adjacent nodes land close together, and every node gets a fresh slot
    // (per-bucket restarts would collide orders across layers).
    const assigned = new Map<string, number>();
    let nextOrder = orderBase;
    for (const layer of [...byLayer.keys()].sort((a, b) => a - b)) {
      const bucket = byLayer.get(layer)!.sort((a, b) => {
        const orderOf = (id: string): number => {
          let best = Number.POSITIVE_INFINITY;
          for (const g of groundsIn.get(id) ?? []) {
            const order = assigned.get(g);
            if (order !== undefined) best = Math.min(best, order);
          }
          return best;
        };
        const oa = orderOf(a);
        const ob = orderOf(b);
        return oa !== ob ? oa - ob : a < b ? -1 : 1;
      });
      for (const id of bucket) assigned.set(id, nextOrder++);
    }

    for (const id of component) {
      this.#place(id, { layer: layers.get(id)!, order: assigned.get(id)! });
    }
  }

  /** Registers a placement and marks its slot occupied. */
  #place(id: string, placement: Placement): void {
    this.#placed.set(id, placement);
    const bucket = this.#occupied.get(placement.layer);
    if (bucket) bucket.add(placement.order);
    else this.#occupied.set(placement.layer, new Set([placement.order]));
  }

  /** The free order in `layer` nearest to `desired` (ties toward the
   * smaller order), so attached nodes cluster around their anchors without
   * ever colliding with a placed node. */
  #freeOrder(layer: number, desired: number): number {
    const bucket = this.#occupied.get(layer);
    const base = Math.max(0, Math.round(desired));
    if (!bucket || !bucket.has(base)) return base;
    for (let distance = 1; ; distance++) {
      const below = base - distance;
      if (below >= 0 && !bucket.has(below)) return below;
      const above = base + distance;
      if (!bucket.has(above)) return above;
    }
  }
}
