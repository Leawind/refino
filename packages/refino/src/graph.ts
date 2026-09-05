import type { Graph, RefinoNode } from "./types.js";

/**
 * Graph assembly from parsed nodes. Pure and filesystem-free so the engine
 * can build graphs from any source.
 */

/**
 * Assemble a graph from nodes: index them by id and build the dependents
 * index. Rejecting duplicate ids is the caller's responsibility.
 */
export function buildGraph(nodes: Iterable<RefinoNode>): Graph {
  const byId = new Map<string, RefinoNode>();
  for (const node of nodes) byId.set(node.id, node);
  return { nodes: byId, dependents: buildDependentsIndex(byId) };
}

function buildDependentsIndex(nodes: Graph["nodes"]): Graph["dependents"] {
  const dependents = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (node.type !== "constraint") continue;
    for (const ground of node.grounds) {
      // Unknown grounds stay out of the index; validateGraph reports them.
      if (!nodes.has(ground)) continue;
      const list = dependents.get(ground);
      if (list) {
        if (!list.includes(node.id)) list.push(node.id);
      } else {
        dependents.set(ground, [node.id]);
      }
    }
  }
  for (const list of dependents.values()) list.sort();
  return dependents;
}
