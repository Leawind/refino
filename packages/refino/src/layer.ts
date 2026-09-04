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
  const tentative = new Map<string, number>();
  for (const [id, node] of byId) {
    groundsIn.set(
      id,
      (node.grounds ?? []).filter((g) => g !== id && byId.has(g)),
    );
  }

  const layers = new Map<string, number>();
  // Strict phase (Kahn over grounds edges): a node layers only once every
  // in-set ground is layered, and its layer is the longest grounds chain
  // ending there. The layer values are unique for the input set, so the
  // processing order only affects traversal, never the result.
  const pending = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const queue: string[] = [];
  for (const [id, grounds] of groundsIn) {
    pending.set(id, grounds.length);
    if (grounds.length === 0) {
      layers.set(id, 0);
      queue.push(id);
    }
    for (const g of grounds) {
      const list = dependents.get(g);
      if (list) list.push(id);
      else dependents.set(g, [id]);
    }
  }
  queue.sort();
  for (let head = 0; head < queue.length; head++) {
    const ground = queue[head]!;
    const groundLayer = layers.get(ground)!;
    for (const dependent of dependents.get(ground) ?? []) {
      const candidate = groundLayer + 1;
      if (candidate > (tentative.get(dependent) ?? 0)) tentative.set(dependent, candidate);
      const left = pending.get(dependent)! - 1;
      pending.set(dependent, left);
      if (left === 0) {
        layers.set(dependent, tentative.get(dependent)!);
        queue.push(dependent);
      }
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
