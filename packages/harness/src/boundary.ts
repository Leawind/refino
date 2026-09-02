import type { Graph } from "refino";
import { getDependents } from "refino";
import { HarnessError } from "./errors.js";
import { byId, unknownNodes } from "./types.js";
import type { RefinoNode } from "refino";
import type { AuthorizationContext, BoundaryZone, ModificationCheck } from "./types.js";

/**
 * Validate an authorization context against the graph: all ids must exist and
 * frontier ids must reference constraint nodes (premises are facts, never
 * decision frontier). Throws `HarnessError` on the first violation.
 */
export function validateContext(graph: Graph, context: AuthorizationContext): void {
  const missing = unknownNodes(graph, [...context.anchors, ...context.frontier]);
  if (missing.length > 0) {
    throw new HarnessError("UNKNOWN_NODE", `Unknown node ids: ${missing.join(", ")}`);
  }
  const notConstraint = context.frontier.filter((id) => graph.nodes.get(id)!.type !== "constraint");
  if (notConstraint.length > 0) {
    throw new HarnessError(
      "FRONTIER_NOT_CONSTRAINT",
      `Decision frontier must reference constraint nodes: ${notConstraint.join(", ")}`,
    );
  }
}

/**
 * The frozen zone: all constraints reachable from the frontier by following
 * `grounds` backwards (docs/crg.md). Frontier nodes themselves are not frozen.
 * Sorted by id.
 */
export function frozenZone(graph: Graph, context: AuthorizationContext): RefinoNode[] {
  validateContext(graph, context);
  const reachable = backwardClosure(graph, context.frontier);
  const frozen: RefinoNode[] = [];
  for (const id of reachable) {
    if (context.frontier.includes(id)) continue;
    const node = graph.nodes.get(id)!;
    if (node.type === "constraint") frozen.push(node);
  }
  return byId(frozen);
}

/**
 * Check whether a node may be modified under the given authorization context.
 * The frontier and its transitive refinements are allowed; frozen ancestors
 * and nodes outside the boundary are blocked with an escalation report.
 */
export function checkModification(
  graph: Graph,
  context: AuthorizationContext,
  id: string,
): ModificationCheck {
  validateContext(graph, context);
  const zone = zoneOf(graph, context, id);
  switch (zone) {
    case "frontier":
    case "refinement":
      return { id, zone, allowed: true };
    default:
      return { id, zone, allowed: false, report: escalate(graph, id, zone) };
  }
}

/** Check a batch of nodes; unknown ids fail the whole check via `HarnessError`. */
export function checkModifications(
  graph: Graph,
  context: AuthorizationContext,
  ids: readonly string[],
): ModificationCheck[] {
  return ids.map((id) => checkModification(graph, context, id));
}

function zoneOf(graph: Graph, context: AuthorizationContext, id: string): BoundaryZone {
  if (context.frontier.includes(id)) return "frontier";
  const frontierSet = new Set(context.frontier);
  if (backwardClosure(graph, context.frontier).has(id)) return "frozen";
  if (forwardClosure(graph, context.frontier).has(id) && !frontierSet.has(id)) {
    return "refinement";
  }
  return "outside";
}

function escalate(
  graph: Graph,
  id: string,
  zone: "frozen" | "outside",
): ModificationCheck["report"] {
  // The graph is valid here (validateContext ran), so dependents always resolve.
  return { id, zone, affected: getDependents(graph, id) };
}

/** ids reachable from seeds by following `grounds` backwards, seeds included. */
function backwardClosure(graph: Graph, seeds: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...seeds];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = graph.nodes.get(id);
    for (const ground of node?.grounds ?? []) queue.push(ground);
  }
  return seen;
}

/** ids reachable from seeds by following `dependents` forwards, seeds included. */
function forwardClosure(graph: Graph, seeds: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...seeds];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dependent of graph.dependents.get(id) ?? []) queue.push(dependent);
  }
  return seen;
}
