/**
 * Longest-path layering (ui README, "布局：分层").
 *
 * Sources sit at layer 0; every other node takes one past the deepest
 * ground reachable behind it, so a node's layer is the length of the
 * longest grounds chain ending there. Layer 0 is the upstream frontier,
 * higher layers are strictly downstream.
 *
 * Constraint→constraint cycles cannot be layered strictly, and the graph
 * tolerates them until validated. For the leftovers the assignment breaks
 * back edges deterministically: unlayered grounds are ignored, and each
 * remaining node takes max(layer of layered grounds) + 1, iterating in id
 * order until every node has a layer.
 */

/** Minimal read-only node shape the layering needs. */
export interface LayerNode {
  id: string;
  grounds?: readonly string[];
}

/** Assigns each node its longest-path layer over the given node set.
 * Grounds pointing outside the set are ignored. */
export function assignLayers(nodes: readonly LayerNode[]): Map<string, number> {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const groundsIn = new Map<string, string[]>();
  for (const [id, node] of byId) {
    groundsIn.set(
      id,
      (node.grounds ?? []).filter((g) => g !== id && byId.has(g)),
    );
  }

  const layers = new Map<string, number>();
  // Strict phase: a node layers only once every ground is layered, so
  // layers settle to the longest-path values (fixed-point iteration).
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const id of byId.keys()) {
      if (layers.has(id)) continue;
      const grounds = groundsIn.get(id)!;
      if (grounds.some((g) => !layers.has(g))) continue;
      let layer = 0;
      for (const g of grounds) layer = Math.max(layer, layers.get(g)! + 1);
      layers.set(id, layer);
      progressed = true;
    }
  }
  // Cycle-breaking phase: leftover nodes sit on or behind a cycle. Id
  // order keeps the approximation deterministic; ignoring still-unlayered
  // grounds cuts the cycle's back edge wherever it happens to fall.
  const leftover = [...byId.keys()].filter((id) => !layers.has(id)).sort();
  let remaining = leftover.length;
  while (remaining > 0) {
    let settled = 0;
    for (const id of leftover) {
      if (layers.has(id)) continue;
      let layer = 0;
      for (const g of groundsIn.get(id)!) {
        const ground = layers.get(g);
        if (ground !== undefined) layer = Math.max(layer, ground + 1);
      }
      layers.set(id, layer);
      settled += 1;
    }
    if (settled === 0) break;
    remaining -= settled;
  }
  return layers;
}
