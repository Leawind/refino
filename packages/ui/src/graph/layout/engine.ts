import type { LayoutDirection } from "../../types";

/**
 * Stateless layered layout (ui README, "布局").
 *
 * Every call computes the layout of exactly the given subgraph from
 * scratch: the whole working set is laid out as if drawn anew, so relative
 * positions always reflect the current structure. Nodes keep no coordinate
 * history across calls.
 *
 * Layers follow the grounds edges (longest-path layering, sources at
 * layer 0); the chosen direction only maps canonical (layer, order)
 * coordinates to x/y, so switching direction never re-lays out. Within a
 * layer each node takes the row nearest to the average of its grounds'
 * rows, so a family spreads symmetrically around its ground instead of
 * drifting to one side. Disjoint groups are laid out as independent
 * components stacked in row ranges (README: 无重叠则作为独立分量排布).
 *
 * The result is a pure function of the input node set (ties ordered by
 * id): the same set always yields the same layout, in any input order.
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
const CROSS_GAP = 32;
/** Empty rows between consecutive independent components. */
const COMPONENT_GAP = 4;

interface Placement {
  layer: number;
  order: number;
}

/** Computes the layered layout of the given subgraph from scratch. */
export function layeredLayout(
  nodes: readonly LayoutNode[],
  direction: LayoutDirection,
): LaidOutNode[] {
  const graph = new Map(nodes.map((node) => [node.id, node] as const));
  const ids = [...graph.keys()].sort();

  const placed = new Map<string, Placement>();
  /** Layer → rows in use; the collision index for new placements. */
  const occupied = new Map<number, Set<number>>();
  const place = (id: string, placement: Placement): void => {
    placed.set(id, placement);
    const bucket = occupied.get(placement.layer);
    if (bucket) bucket.add(placement.order);
    else occupied.set(placement.layer, new Set([placement.order]));
  };
  /** The free row in `layer` nearest to `desired` (ties toward the smaller
   * row), so nodes cluster around their anchors — symmetrically, on either
   * side — without ever colliding with a placed node. */
  const freeOrder = (layer: number, desired: number): number => {
    const bucket = occupied.get(layer);
    const base = Math.round(desired);
    if (!bucket || !bucket.has(base)) return base;
    for (let distance = 1; ; distance++) {
      const below = base - distance;
      if (!bucket.has(below)) return below;
      const above = base + distance;
      if (!bucket.has(above)) return above;
    }
  };

  // Components stack in disjoint row ranges; every node is a regular node.
  placeComponents(ids, graph, placed, place, freeOrder);

  const horizontal = direction === "LR" || direction === "RL";
  const result: LaidOutNode[] = [];
  for (const id of ids) {
    const placement = placed.get(id)!;
    const main = placement.layer * (horizontal ? NODE_WIDTH + LAYER_GAP : NODE_HEIGHT + LAYER_GAP);
    const cross = placement.order * (horizontal ? NODE_HEIGHT + CROSS_GAP : NODE_WIDTH + CROSS_GAP);
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

/** Lays out each connected group of the nodes as an independent component
 * in its own row range. */
function placeComponents(
  regular: readonly string[],
  graph: ReadonlyMap<string, LayoutNode>,
  placed: ReadonlyMap<string, Placement>,
  place: (id: string, placement: Placement) => void,
  freeOrder: (layer: number, desired: number) => number,
): void {
  const regularSet = new Set(regular);
  const groundsIn = new Map<string, string[]>();
  for (const id of regular) {
    groundsIn.set(
      id,
      (graph.get(id)!.grounds ?? []).filter((g) => regularSet.has(g)),
    );
  }
  const depsIn = new Map<string, string[]>();
  for (const [id, list] of groundsIn) {
    for (const g of list) {
      const entry = depsIn.get(g);
      if (entry) entry.push(id);
      else depsIn.set(g, [id]);
    }
  }

  const visited = new Set<string>();
  for (const root of regular) {
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
    placeComponent(component.sort(), groundsIn, placed, place, freeOrder);
  }
}

/** Longest-path layering inside the component, then BFS-derived row order
 * per layer with the family-centering placement. */
function placeComponent(
  component: readonly string[],
  groundsIn: ReadonlyMap<string, string[]>,
  placed: ReadonlyMap<string, Placement>,
  place: (id: string, placement: Placement) => void,
  freeOrder: (layer: number, desired: number) => number,
): void {
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

  // Components stack in disjoint row ranges: this one starts below every
  // row placed so far (the first component's roots start at row 0).
  let orderBase = 0;
  for (const placement of placed.values()) {
    orderBase = Math.max(orderBase, placement.order + 1 + COMPONENT_GAP);
  }

  const byLayer = new Map<number, string[]>();
  for (const id of component) {
    const layer = layers.get(id)!;
    const bucket = byLayer.get(layer);
    if (bucket) bucket.push(id);
    else byLayer.set(layer, [id]);
  }
  // Buckets are sorted by their parents' rows (min ground order, then id)
  // so adjacent nodes land close together. Each node takes the free slot
  // nearest to the average of its grounds' rows: a family centers on its
  // ground instead of drifting to one side of it (README: 相邻层中点对齐).
  const assigned = new Map<string, number>();
  let rootCount = 0;
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
    for (const id of bucket) {
      const grounds = (groundsIn.get(id) ?? [])
        .map((g) => assigned.get(g))
        .filter((order): order is number => order !== undefined);
      const desired =
        grounds.length > 0
          ? grounds.reduce((sum, order) => sum + order, 0) / grounds.length
          : orderBase + rootCount++;
      const order = freeOrder(layer, desired);
      assigned.set(id, order);
      // Placing immediately keeps later nodes in this layer off the slot.
      place(id, { layer, order });
    }
  }
}
