import { getDependents } from "refino";
import type { Graph, RefinoNode } from "refino";
import { byId, unknownNodes } from "./types.js";
import { HarnessError } from "./errors.js";

/**
 * Constraints pending review after the given nodes changed: all constraints
 * whose `grounds` transitively contain any changed node (docs/crg.md §1.6).
 * Pending review is a derived state, computed in memory and never persisted.
 * Sorted by id, deduplicated.
 */
export function pendingReview(graph: Graph, changedIds: readonly string[]): RefinoNode[] {
  const missing = unknownNodes(graph, changedIds);
  if (missing.length > 0) {
    throw new HarnessError("UNKNOWN_NODE", `Unknown node ids: ${missing.join(", ")}`);
  }
  const pending = new Map<string, RefinoNode>();
  for (const id of changedIds) {
    for (const { node } of getDependents(graph, id)) pending.set(node.id, node);
  }
  return byId(pending.values());
}
