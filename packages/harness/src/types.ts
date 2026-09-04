import type { Graph, NodeWithDepth, RefinoNode } from "refino";

/**
 * Authorization context of a task (docs/crg.md, task delimitation layer).
 * Validation is based solely on this context, never on actor identity.
 */
export interface AuthorizationContext {
  /**
   * Scope anchor node ids: the CRG nodes loaded when the task starts. They
   * determine the initial decision context, not what may be modified.
   */
  anchors: string[];
  /**
   * Frozen constraint ids naming the frozen zone: the zone is these
   * constraints plus all their ancestor nodes (docs/crg.md 2.4). Everything
   * outside the zone is the modification space; new nodes created in the
   * task belong to it.
   */
  frozen: string[];
}

/** Where a node sits relative to the modification space of a task. */
export type NodeZone =
  /** A node in the frozen zone: readable, not modifiable. */
  | "frozen"
  /** A constraint outside the frozen zone: within the modification space. */
  | "modifiable"
  /** A premise: premise updates follow the maintenance protocol, not this context. */
  | "premise";

/** Result of checking one node against the modification space. */
export interface ModificationCheck {
  id: string;
  zone: NodeZone;
  allowed: boolean;
  /** Present when the modification is not allowed. */
  report?: EscalationReport;
}

/**
 * Structured escalation report for a blocked modification
 * (docs/crg.md, boundary escalation). Suggested changes and in-boundary
 * alternatives are the caller's responsibility to fill in.
 */
export interface EscalationReport {
  /** The blocked node. */
  id: string;
  zone: Exclude<NodeZone, "modifiable">;
  /** Downstream constraints a change to the blocked node would affect. */
  affected: NodeWithDepth[];
}

/**
 * A rendered context block with a stable identity. Hosts inject blocks into
 * the conversation; delta events reference blocks by id so an incremental
 * update stays unambiguous and prompt-cache friendly.
 */
export interface ContextBlock {
  /** Stable block identifier, e.g. `frozen:E5F6G7H8`. */
  id: string;
  kind: ContextBlockKind;
  nodeId: string;
  text: string;
}

export type ContextBlockKind = "anchor" | "premise" | "frozen";

/**
 * Incremental change between two authorization contexts. Hosts inject only
 * these events instead of re-rendering the full context, keeping the stable
 * prefix intact for model prompt caches.
 */
export type DeltaEvent =
  | { type: "anchor_added"; id: string }
  | { type: "anchor_removed"; id: string }
  | { type: "frozen_added"; id: string }
  | { type: "frozen_removed"; id: string };

/** Result of `defaultAuthorizationContext`. */
export interface DefaultContext {
  context: AuthorizationContext;
  /** Whether the anchors cover every node in the graph. */
  complete: boolean;
}

/** Context node ids reference nodes that do not exist in the graph. */
export function unknownNodes(graph: Graph, ids: readonly string[]): string[] {
  return ids.filter((id) => !graph.nodes.has(id));
}

/** Sort nodes by id for deterministic output. */
export function byId(nodes: Iterable<RefinoNode>): RefinoNode[] {
  return [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
