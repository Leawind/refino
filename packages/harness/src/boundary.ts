import type { Graph, NodeWithDepth } from "refino";
import { getDependents } from "refino";
import { HarnessError } from "./errors.js";
import { byId, unknownNodes } from "./types.js";
import type { RefinoNode } from "refino";
import type { AuthorizationContext, ModificationCheck, NodeZone } from "./types.js";

/**
 * Validate an authorization context against the graph: all ids must exist and
 * frozen ids must reference constraint nodes (premise updates follow the
 * maintenance protocol, never the context's frozen list). Throws
 * `HarnessError` on the first violation.
 */
export function validateContext(graph: Graph, context: AuthorizationContext): void {
  const missing = unknownNodes(graph, [...context.anchors, ...context.frozen]);
  if (missing.length > 0) {
    throw new HarnessError("UNKNOWN_NODE", `Unknown node ids: ${missing.join(", ")}`);
  }
  const notConstraint = context.frozen.filter((id) => graph.nodes.get(id)!.type !== "constraint");
  if (notConstraint.length > 0) {
    throw new HarnessError(
      "FROZEN_NOT_CONSTRAINT",
      `The frozen list must reference constraint nodes: ${notConstraint.join(", ")}`,
    );
  }
}

/**
 * The frozen zone: the constraints named by the context closed upwards along
 * `grounds` — a frozen node's ancestors join the zone, constraints and
 * premises alike (docs/crg.md 2.4). Sorted by id.
 */
export function frozenZone(graph: Graph, context: AuthorizationContext): RefinoNode[] {
  validateContext(graph, context);
  const frozen = frozenIds(graph, context);
  return byId([...frozen].map((id) => graph.nodes.get(id)!));
}

/**
 * The most downstream constraints of the frozen zone: zone nodes none of
 * whose direct dependents are in the zone. The zone is their upward closure,
 * so they are its minimal representation — user-facing surfaces show and
 * unfreeze the zone through them (docs/crg.md 2.4). Sorted by id.
 */
export function frozenFrontier(graph: Graph, context: AuthorizationContext): RefinoNode[] {
  const zone = new Set(frozenZone(graph, context).map((n) => n.id));
  return byId(
    [...zone]
      .map((id) => graph.nodes.get(id)!)
      .filter((n) => !(graph.dependents.get(n.id) ?? []).some((d) => zone.has(d))),
  );
}

/**
 * Constraints that may still be frozen under the context: every constraint
 * outside the frozen zone. Freeze candidates exclude zone members — freezing
 * them would change nothing. Premises are never freezable; they follow the
 * maintenance protocol. Sorted by id.
 */
export function freezableConstraints(graph: Graph, context: AuthorizationContext): RefinoNode[] {
  validateContext(graph, context);
  const zone = frozenIds(graph, context);
  return byId([...graph.nodes.values()].filter((n) => n.type === "constraint" && !zone.has(n.id)));
}

/**
 * Check whether a node may be modified under the given authorization context.
 * Everything outside the frozen zone is within the modification space;
 * frozen constraints are blocked with an escalation report, and premises are
 * blocked because their updates follow the maintenance protocol (2.0),
 * whether or not they sit in the zone. Unknown ids throw `HarnessError`.
 */
export function checkModification(
  graph: Graph,
  context: AuthorizationContext,
  id: string,
): ModificationCheck {
  validateContext(graph, context);
  const zone = zoneOf(graph, context, id);
  if (zone === "modifiable") return { id, zone, allowed: true };
  return { id, zone, allowed: false, report: { id, zone, affected: getDependents(graph, id) } };
}

/** Check a batch of nodes; unknown ids fail the whole check via `HarnessError`. */
export function checkModifications(
  graph: Graph,
  context: AuthorizationContext,
  ids: readonly string[],
): ModificationCheck[] {
  return ids.map((id) => checkModification(graph, context, id));
}

/**
 * Frozen constraints within the transitive dependents of the given nodes:
 * a modification whose downstream repair reaches these escalates (3.2/3.4).
 * Call after `checkModification` cleared the targets themselves. Deduplicated
 * and sorted by id.
 */
export function frozenDependents(
  graph: Graph,
  context: AuthorizationContext,
  ids: readonly string[],
): NodeWithDepth[] {
  validateContext(graph, context);
  const frozen = frozenIds(graph, context);
  const found = new Map<string, NodeWithDepth>();
  for (const id of ids) {
    for (const dependent of getDependents(graph, id)) {
      if (frozen.has(dependent.node.id)) found.set(dependent.node.id, dependent);
    }
  }
  return [...found.values()].sort((a, b) =>
    a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0,
  );
}

function zoneOf(graph: Graph, context: AuthorizationContext, id: string): NodeZone {
  const node = graph.nodes.get(id);
  if (!node) throw new HarnessError("UNKNOWN_NODE", `Unknown node id: ${id}`);
  if (node.type === "premise") return "premise";
  return frozenIds(graph, context).has(id) ? "frozen" : "modifiable";
}

/** ids closed upwards from the context's frozen list by following `grounds`, seeds included. */
function frozenIds(graph: Graph, context: AuthorizationContext): Set<string> {
  const frozen = new Set<string>(context.frozen);
  const queue = [...context.frozen];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!;
    for (const ground of graph.nodes.get(id)?.grounds ?? []) {
      if (!frozen.has(ground)) {
        frozen.add(ground);
        queue.push(ground);
      }
    }
  }
  return frozen;
}
