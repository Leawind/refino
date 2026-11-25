import type { Graph } from "refino";

/**
 * The anchors of a task that selected none: every node while the graph stays
 * within `maxAutoNodes`; above that budget there is no baseline context.
 * Hosts then inject a minimal orientation instead, and the model locates
 * nodes by search — injecting a summary of every node would spend the whole
 * context window on the graph itself.
 */
export interface DerivedAnchors {
  anchors: string[];
  /** Whether the anchors cover every node in the graph. */
  complete: boolean;
}

export function derivedAnchors(graph: Graph, maxAutoNodes = 1024): DerivedAnchors {
  const complete = graph.nodes.size <= maxAutoNodes;
  return { anchors: complete ? [...graph.nodes.keys()].sort() : [], complete };
}
