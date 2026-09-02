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
   * Decision frontier constraint ids: the modification boundary. Ancestors
   * reachable from the frontier form the frozen zone; the frontier and its
   * refinements are the authorized modification space.
   */
  frontier: string[];
}

/** Where a node sits relative to the modification boundary of a task. */
export type BoundaryZone =
  /** A decision frontier node itself. */
  | "frontier"
  /** A transitive refinement (dependent) of a frontier node. */
  | "refinement"
  /** A frozen ancestor constraint of the frontier: readable, not modifiable. */
  | "frozen"
  /** Unrelated to the frontier: neither frontier, refinement, nor frozen. */
  | "outside";

/** Result of checking one node against the modification boundary. */
export interface ModificationCheck {
  id: string;
  zone: BoundaryZone;
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
  /** Why the modification is blocked. */
  zone: Exclude<BoundaryZone, "frontier" | "refinement">;
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

export type ContextBlockKind = "anchor" | "frozen" | "frontier" | "refinement";

/**
 * Incremental change between two authorization contexts. Hosts inject only
 * these events instead of re-rendering the full context, keeping the stable
 * prefix intact for model prompt caches.
 */
export type DeltaEvent =
  | { type: "anchor_added"; id: string }
  | { type: "anchor_removed"; id: string }
  | { type: "frontier_added"; id: string }
  | { type: "frontier_removed"; id: string }
  | { type: "frozen"; id: string }
  | { type: "unfrozen"; id: string };

/** Result of one id in a batch query: results, or a per-id error. */
export type QueryGroup<T> = { id: string; results: T[] } | { id: string; error: string };

/** Context node ids reference nodes that do not exist in the graph. */
export function unknownNodes(graph: Graph, ids: readonly string[]): string[] {
  return ids.filter((id) => !graph.nodes.has(id));
}

/** Sort nodes by id for deterministic output. */
export function byId(nodes: Iterable<RefinoNode>): RefinoNode[] {
  return [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
