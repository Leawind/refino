/**
 * Reference document: docs/crg.md (Constraint Refinement Graph).
 *
 * A graph holds two kinds of nodes:
 * - premise nodes: objective project facts, never have `grounds`;
 * - constraint nodes: project decisions, optionally grounded on premises
 *   and/or upstream constraints.
 */

export type NodeType = "premise" | "constraint";

export interface RefinoNode {
  id: string;
  type: NodeType;
  /** Path relative to the `.refino` directory, with `/` as the separator regardless of platform, e.g. `nodes/01/9ABCDE.constraint.md`. */
  file: string;
  /** First paragraph of the markdown body; used for quick relevance checks. */
  summary: string;
  /** Full markdown body (trimmed), excluding frontmatter fields like rationale. */
  body: string;
  /** Constraint nodes only: ground ids, deduplicated, in declared order. */
  grounds?: string[];
  /** Constraint nodes only: why the decision was made; independent and optional. */
  rationale?: string;
  /** Premise nodes only: RFC 3339 timestamp with an explicit UTC offset. */
  confirmed?: string;
}

export interface Graph {
  /** Path of the `.refino` directory the graph was built from. */
  refinoDir: string;
  /** All nodes indexed by id. Node identity is the `id`, never the file path. */
  nodes: Map<string, RefinoNode>;
  /** id -> ids of constraints whose `grounds` directly contain that id (sorted, deduplicated). */
  dependents: Map<string, string[]>;
}

export type IssueCode =
  | "INVALID_FRONTMATTER"
  | "INVALID_ID"
  | "INVALID_NODE_PATH"
  | "PREMISE_WITH_GROUNDS"
  | "INVALID_GROUNDS"
  | "INVALID_CONFIRMED"
  | "DUPLICATE_ID"
  | "UNKNOWN_GROUND"
  | "CYCLE"
  | "REFINO_DIR_NOT_FOUND"
  | "NODE_NOT_FOUND";

export interface RefinoIssue {
  code: IssueCode;
  message: string;
  /** Node file the issue relates to, relative to the `.refino` directory. */
  file?: string;
  /** Node id the issue relates to. */
  nodeId?: string;
  /** For UNKNOWN_GROUND: the referenced id that does not exist. */
  groundId?: string;
  /** For CYCLE: the closed path, e.g. ["01ABCDEF","02ABCDEF","01ABCDEF"]. */
  cycle?: string[];
}

export class RefinoError extends Error {
  readonly code: IssueCode;

  constructor(code: IssueCode, message: string) {
    super(message);
    this.name = "RefinoError";
    this.code = code;
  }
}
