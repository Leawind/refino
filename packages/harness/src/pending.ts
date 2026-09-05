import type { Graph, RefinoNode } from "refino";
import { byId, unknownNodes } from "./types.js";
import { HarnessError } from "./errors.js";

/**
 * Constraints pending review after the given nodes changed: the direct
 * dependents of each changed node (docs/crg.md §1.6). Reviews cascade
 * one hop at a time - a reviewer's own modification pulls its downstream
 * in via the modification-check rules, not by pre-flagging the whole
 * closure. Pending review is a derived state, computed in memory and
 * never persisted. Sorted by id, deduplicated.
 */
export function pendingReview(graph: Graph, changedIds: readonly string[]): RefinoNode[] {
  const missing = unknownNodes(graph, changedIds);
  if (missing.length > 0) {
    throw new HarnessError("UNKNOWN_NODE", `Unknown node ids: ${missing.join(", ")}`);
  }
  const pending = new Map<string, RefinoNode>();
  for (const id of changedIds) {
    for (const dependent of graph.nodes.get(id)?.children ?? []) {
      const node = graph.nodes.get(dependent);
      if (node) pending.set(dependent, node);
    }
  }
  return byId(pending.values());
}
