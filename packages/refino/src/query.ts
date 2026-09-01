import { RefinoError } from "./types.js";
import type { Graph, RefinoNode } from "./types.js";

export interface NodeWithDepth {
  node: RefinoNode;
  /** Distance from the queried node: direct grounds/dependents have depth 1. */
  depth: number;
}

/** Return the node with the given id, throwing if it does not exist. */
export function requireNode(graph: Graph, id: string): RefinoNode {
  const node = graph.nodes.get(id);
  if (!node) {
    throw new RefinoError("NODE_NOT_FOUND", `Node "${id}" not found`);
  }
  return node;
}

/** Direct grounds of a node, resolved and in declared order. */
export function getGrounds(graph: Graph, id: string): RefinoNode[] {
  const node = requireNode(graph, id);
  const result: RefinoNode[] = [];
  for (const ground of node.grounds ?? []) {
    const target = graph.nodes.get(ground);
    if (target) result.push(target);
  }
  return result;
}

/**
 * All nodes reachable from a node by recursively following `grounds`
 * (premises and upstream constraints), excluding the node itself.
 */
export function getAncestors(graph: Graph, id: string): NodeWithDepth[] {
  requireNode(graph, id);
  return breadthFirst(graph, id, (node) =>
    (node.grounds ?? []).flatMap((g) => {
      const target = graph.nodes.get(g);
      return target ? [g] : [];
    }),
  );
}

/**
 * All constraint nodes that directly or indirectly depend on a node, i.e.
 * whose `grounds` transitively contain it, excluding the node itself.
 */
export function getDependents(graph: Graph, id: string): NodeWithDepth[] {
  requireNode(graph, id);
  return breadthFirst(graph, id, (node) => graph.dependents.get(node.id) ?? []);
}

/** Alias of `getDependents`: the impact set of a node. */
export const getImpact = getDependents;

function breadthFirst(
  graph: Graph,
  start: string,
  neighborsOf: (node: RefinoNode) => string[],
): NodeWithDepth[] {
  const depth = new Map<string, number>([[start, 0]]);
  const queue: string[] = [start];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!;
    const currentDepth = depth.get(current)!;
    const node = graph.nodes.get(current);
    if (!node) continue; // unknown ids can only appear in an invalid graph
    for (const neighbor of neighborsOf(node)) {
      if (!depth.has(neighbor)) {
        depth.set(neighbor, currentDepth + 1);
        queue.push(neighbor);
      }
    }
  }
  depth.delete(start);
  return [...depth.entries()]
    .map(([nodeId, d]) => ({ node: graph.nodes.get(nodeId)!, depth: d }))
    .sort(byDepthThenId);
}

function byDepthThenId(a: NodeWithDepth, b: NodeWithDepth): number {
  if (a.depth !== b.depth) return a.depth - b.depth;
  return a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0;
}
