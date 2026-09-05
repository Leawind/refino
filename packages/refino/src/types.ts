/**
 * Reference document: docs/crg.md (Constraint Refinement Graph).
 *
 * A graph holds two kinds of nodes:
 * - premise nodes: objective project facts, never have `grounds`;
 * - constraint nodes: project decisions, optionally grounded on premises
 *   and/or upstream constraints.
 */

export type NodeType = "premise" | "constraint";

/** Shared fields of both node kinds; the `type` discriminant picks the rest. */
interface NodeBase {
  id: string;
  type: NodeType;
  /** Independent summary attribute for quick relevance checks; the storage layer may derive it from the body's first paragraph when none is declared. */
  summary: string;
  /** Full body text (trimmed), excluding metadata fields like rationale. */
  body: string;
}

/** An objective project fact: never grounds on other nodes. */
export interface PremiseNode extends NodeBase {
  type: "premise";
  /** RFC 3339 timestamp with an explicit UTC offset. */
  confirmed?: string;
}

/** A project decision that limits downstream choice space. */
export interface ConstraintNode extends NodeBase {
  type: "constraint";
  /** Ground ids, deduplicated, in declared order; empty when the constraint has no grounds (a root constraint). */
  grounds: string[];
  /** Why the decision was made; independent and optional. */
  rationale?: string;
}

export type RefinoNode = PremiseNode | ConstraintNode;

/**
 * Light node shape carried by batch query results (docs/design.md, "画布按
 * 需查询"): id, type, summary and grounds — no body. Premises and
 * not-yet-loaded constraints omit `grounds`.
 */
export interface NodeLite {
  id: string;
  type: NodeType;
  summary: string;
  /** Constraint nodes only. */
  grounds?: readonly string[];
}

export interface Graph {
  /** All nodes indexed by id. Node identity is the `id`. */
  nodes: Map<string, RefinoNode>;
  /** id -> ids of constraints whose `grounds` directly contain that id (sorted, deduplicated). */
  dependents: Map<string, string[]>;
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
  /** A premise declares `grounds` (parse) or grounds are applied to a premise target (write check). */
  PremiseWithGrounds = "PREMISE_WITH_GROUNDS",
  /** A `grounds` list or entry is malformed, or lists the same id more than once. */
  InvalidGrounds = "INVALID_GROUNDS",
  /** `confirmed` is not an RFC 3339 timestamp with an explicit UTC offset. */
  InvalidConfirmed = "INVALID_CONFIRMED",
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
