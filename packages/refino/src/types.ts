/**
 * Reference document: docs/crg.md (Constraint Refinement Graph).
 *
 * A graph holds two kinds of nodes:
 * - premise nodes: objective project facts, never have `grounds`;
 * - constraint nodes: project decisions, optionally grounded on premises
 *   and/or upstream constraints.
 *
 * A `grounds` field on a premise is an ordinary misplaced attribute, exactly
 * like any unknown frontmatter field: producers silently ignore it. Edges
 * only ever come from constraint `grounds`.
 *
 * These types are the engine's resident memory model (docs/design.md,
 * "渐进披露与常驻集"): id, type, summary and the graph relations always
 * stay in memory. Body and rationale are paged content supplied by the
 * storage layer by id — they are not part of engine types, and no topology
 * operation needs them.
 */

export type NodeType = "premise" | "constraint";

/** An objective project fact: never grounds on other nodes. */
export interface PremiseNode {
  id: string;
  type: "premise";
  /** Independent summary attribute for quick relevance checks; the storage layer may derive it from the body's first paragraph when none is declared. */
  summary: string;
  /** Confirmation time as epoch milliseconds; the storage layer converts to and from the file's RFC 3339 form. */
  confirmed?: number;
}

/** A project decision that limits downstream choice space. */
export interface ConstraintNode {
  id: string;
  type: "constraint";
  /** Independent summary attribute for quick relevance checks; the storage layer may derive it from the body's first paragraph when none is declared. */
  summary: string;
  /** Ground ids, deduplicated, in declared order; empty when the constraint has no grounds (a root constraint). */
  grounds: string[];
}

export type RefinoNode = PremiseNode | ConstraintNode;

/**
 * Light node shape carried by batch query results (docs/design.md, "画布按
 * 需查询"): id, type, summary and grounds — the resident fields without
 * premise `confirmed`. Premises and not-yet-loaded constraints omit
 * `grounds`.
 */
export interface NodeLite {
  id: string;
  type: NodeType;
  summary: string;
  /** Constraint nodes only. */
  grounds?: readonly string[];
}

/**
 * Graph-attached node: the resident record plus the derived child
 * back-references (ids of constraints whose `grounds` directly contain this
 * id; sorted, deduplicated; maintained by `buildGraph` and the mutation
 * primitives). Premises have children but no grounds; root constraints have
 * neither.
 */
export type GraphNode = RefinoNode & { children: readonly string[] };

export interface Graph {
  /** All nodes indexed by id. Node identity is the `id`. */
  nodes: Map<string, GraphNode>;
}

/**
 * Result of one id in a batch query: the queried results, or a per-id error
 * when the id does not resolve. The shared return contract of all batch
 * query interfaces (CLI, harness tools, Web on-demand queries) — batch
 * queries use partial-success semantics, so a missing id never aborts the
 * remaining ids.
 */
export type QueryGroup<T> = { id: string; results: T[] } | { id: string; error: string };

/**
 * Codes of issues and thrown errors emitted by the engine itself, all of
 * them graph-level semantics. The string values are the wire format (CLI
 * `--json` output, web API responses), so members keep their
 * SCREAMING_SNAKE spelling as the value. Other emitters define their own
 * codes (`RefinoIssue.code` and `RefinoError.code` accept any string):
 * storage-format codes belong to `@refino/storage`, request-shape codes to
 * the web layer, and so on.
 */
export enum IssueCode {
  /** A node id (from any source) fails the engine's id rule. */
  InvalidId = "INVALID_ID",
  /** A `grounds` list or entry is malformed, or lists the same id more than once. */
  InvalidGrounds = "INVALID_GROUNDS",
  /** Two nodes carry the same id; ids are globally unique across the graph. */
  DuplicateId = "DUPLICATE_ID",
  /** A `grounds` reference does not resolve to an existing node; carries `groundId`. */
  UnknownGround = "UNKNOWN_GROUND",
  /** A constraint -> constraint `grounds` path closes; carries `cycle`. */
  Cycle = "CYCLE",
  /** An id does not resolve to a node (thrown as a `RefinoError`). */
  NodeNotFound = "NODE_NOT_FOUND",
}

export interface RefinoIssue {
  /** Wire code; the engine emits `IssueCode` values, other emitters their own. */
  code: string;
  message: string;
  /** Node id the issue relates to. */
  nodeId?: string;
  /** Only for `IssueCode.UnknownGround`: the referenced id that does not exist. */
  groundId?: string;
  /** Only for `IssueCode.Cycle`: the closed path, e.g. ["01ABCDEF","02ABCDEF","01ABCDEF"]. */
  cycle?: string[];
}

export class RefinoError extends Error {
  /** Wire code; the engine throws with `IssueCode` values, other emitters their own. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RefinoError";
    this.code = code;
  }
}
