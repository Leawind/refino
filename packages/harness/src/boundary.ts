import type { Graph } from "refino";
import { getDependents } from "refino";
import { HarnessError } from "./errors.js";
import { byId, unknownNodes } from "./types.js";
import type { RefinoNode } from "refino";
import type { AuthorizationContext, ModificationCheck, NodeZone } from "./types.js";

/**
 * Validate an authorization context against the graph: all ids must exist,
 * appear at most once per list, and frozen ids must reference decision
 * nodes (premises join the zone only as ancestors of frozen decisions).
 * Throws `HarnessError` on the first violation.
 */
export function validateContext(graph: Graph, context: AuthorizationContext): void {
  const missing = unknownNodes(graph, [...context.anchors, ...context.frozen]);
  if (missing.length > 0) {
    throw new HarnessError("UNKNOWN_NODE", `Unknown node ids: ${missing.join(", ")}`);
  }
  const duplicated = [...duplicates(context.anchors), ...duplicates(context.frozen)];
  if (duplicated.length > 0) {
    throw new HarnessError(
      "DUPLICATE_CONTEXT_ID",
      `Authorization context lists duplicate ids: ${duplicated.join(", ")}`,
    );
  }
  const notDecision = context.frozen.filter((id) => graph.nodes.get(id)!.type !== "decision");
  if (notDecision.length > 0) {
    throw new HarnessError(
      "FROZEN_NOT_CONSTRAINT",
      `The frozen list must reference decision nodes: ${notDecision.join(", ")}`,
    );
  }
}

/** Ids that appear more than once in the list, in first-duplicate order. */
function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicated.add(id);
    else seen.add(id);
  }
  return [...duplicated];
}

/**
 * The frozen zone: the decisions named by the context closed upwards along
 * `grounds` — a frozen node's ancestors join the zone, decisions and
 * premises alike (docs/dlg.md 2.4). Sorted by id.
 */
export function frozenZone(graph: Graph, context: AuthorizationContext): RefinoNode[] {
  validateContext(graph, context);
  const frozen = frozenIds(graph, context);
  return byId([...frozen].map((id) => graph.nodes.get(id)!));
}

/**
 * The most downstream decisions of the frozen zone: zone nodes none of
 * whose direct dependents are in the zone. The zone is their upward closure,
 * so they are its minimal representation — user-facing surfaces show and
 * unfreeze the zone through them (docs/dlg.md 2.4). Sorted by id.
 */
export function frozenFrontier(graph: Graph, context: AuthorizationContext): RefinoNode[] {
  const zone = new Set(frozenZone(graph, context).map((n) => n.id));
  return byId(
    [...zone].map((id) => graph.nodes.get(id)!).filter((n) => !n.children.some((d) => zone.has(d))),
  );
}

/**
 * Decisions that may still be frozen under the context: every decision
 * outside the frozen zone. Freeze candidates exclude zone members — freezing
 * them would change nothing. Premises are never named directly; they join
 * the zone as ancestors of frozen decisions. Sorted by id.
 */
export function freezableDecisions(graph: Graph, context: AuthorizationContext): RefinoNode[] {
  validateContext(graph, context);
  const zone = frozenIds(graph, context);
  return byId([...graph.nodes.values()].filter((n) => n.type === "decision" && !zone.has(n.id)));
}

/**
 * Check whether a node may be modified under the given authorization context.
 * Everything outside the frozen zone is within the modification space,
 * decisions and premises alike; a node in the zone — whatever its type —
 * is blocked with an escalation report. Unknown ids throw `HarnessError`.
 */
export function checkModification(
  graph: Graph,
  context: AuthorizationContext,
  id: string,
): ModificationCheck {
  validateContext(graph, context);
  const zone = zoneOf(graph, context, id);
  if (zone === "modifiable") return { id, zone, allowed: true };
  return { id, zone, allowed: false, report: { id, affected: getDependents(graph, id) } };
}

/** Check a batch of nodes; unknown ids fail the whole check via `HarnessError`. */
export function checkModifications(
  graph: Graph,
  context: AuthorizationContext,
  ids: readonly string[],
): ModificationCheck[] {
  return ids.map((id) => checkModification(graph, context, id));
}

function zoneOf(graph: Graph, context: AuthorizationContext, id: string): NodeZone {
  const node = graph.nodes.get(id);
  if (!node) throw new HarnessError("UNKNOWN_NODE", `Unknown node id: ${id}`);
  return frozenIds(graph, context).has(id) ? "frozen" : "modifiable";
}

/** ids closed upwards from the context's frozen list by following `grounds`, seeds included. */
function frozenIds(graph: Graph, context: AuthorizationContext): Set<string> {
  const frozen = new Set<string>(context.frozen);
  const queue = [...context.frozen];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!;
    // Premises declare no grounds, so only decisions extend the closure.
    const node = graph.nodes.get(id);
    const grounds = node?.type === "decision" ? node.grounds : [];
    for (const ground of grounds) {
      if (!frozen.has(ground)) {
        frozen.add(ground);
        queue.push(ground);
      }
    }
  }
  return frozen;
}
