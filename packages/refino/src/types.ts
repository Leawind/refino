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
  /** Path relative to the `.refino` directory, e.g. `constraints/C-019.md`. */
  file: string;
  /** First paragraph of the markdown body; used for quick relevance checks. */
  summary: string;
  /** Full markdown body (trimmed), i.e. content plus rationale. */
  body: string;
  /** Constraint nodes only: ground ids, deduplicated, in declared order. */
  grounds?: string[];
}

export interface Graph {
  /** Absolute path of the `.refino` directory the graph was loaded from. */
  refinoDir: string;
  /** All nodes indexed by id. Node identity is the `id`, never the file path. */
  nodes: Map<string, RefinoNode>;
  /** id -> ids of constraints whose `grounds` directly contain that id (sorted, deduplicated). */
  dependents: Map<string, string[]>;
}

export type IssueCode =
  | "MISSING_FRONTMATTER"
  | "INVALID_FRONTMATTER"
  | "MISSING_ID"
  | "INVALID_ID"
  | "MISSING_TYPE"
  | "INVALID_TYPE"
  | "TYPE_DIR_MISMATCH"
  | "PREMISE_WITH_GROUNDS"
  | "INVALID_GROUNDS"
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
  /** For CYCLE: the closed path, e.g. ["C-001","C-002","C-001"]. */
  cycle?: string[];
}

export interface LoadResult {
  graph: Graph;
  /** Issues found while reading and parsing node files (including duplicate ids). */
  issues: RefinoIssue[];
}

export class RefinoError extends Error {
  readonly code: IssueCode;

  constructor(code: IssueCode, message: string) {
    super(message);
    this.name = "RefinoError";
    this.code = code;
  }
}
