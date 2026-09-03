/** Shared front-end types mirroring the JSON API contract (docs/design.md,
 * "后端 API 契约" and "画布按需查询"). */

export type NodeType = "premise" | "constraint";

/** Light node shape carried by all canvas query results (no body). */
export interface NodeLite {
  id: string;
  type: NodeType;
  summary: string;
  /** Constraint nodes only. */
  grounds?: readonly string[];
}

/** Engine's batch result shape: per-id results or a per-id error. */
export type QueryGroup<T> = { id: string; results: T[] } | { id: string; error: string };

export interface NodeWithDepth extends NodeLite {
  /** Distance from the query's anchor node; 0 for the anchor itself. */
  depth: number;
}

/** One id's neighborhood: nearest-first, truncated when over the limit. */
export interface Neighborhood {
  truncated: boolean;
  nodes: NodeWithDepth[];
}

/** One id's strong siblings: overlap-descending, truncated when over the limit. */
export interface SiblingSet {
  truncated: boolean;
  nodes: Array<NodeLite & { overlap: number }>;
}

export type RangeMode = "ancestor" | "branches" | "disconnected";

export interface RangeNode extends NodeLite {
  /** Depth from focus; null when the node is unreachable from focus. */
  depth: number | null;
}

export interface RangeResult {
  mode: RangeMode;
  nodes: RangeNode[];
}

export interface SearchNode {
  id: string;
  type: NodeType;
  summary: string;
}

export interface SearchPage {
  nodes: SearchNode[];
  /** Id after which to continue; absent on the last page. */
  nextCursor?: string;
}

/** Full node record as exposed by GET /api/nodes/:id. */
export interface NodeRecord {
  id: string;
  type: NodeType;
  file: string;
  summary: string;
  body: string;
  grounds?: string[];
  rationale?: string;
  confirmed?: string;
}

export interface IssueRecord {
  code: string;
  message: string;
  file?: string;
  nodeId?: string;
  groundId?: string;
}

/** GET /api/nodes/:id — full node plus per-node issues and the revision for
 * If-Match-style saves. */
export interface NodeDetail {
  revision: number;
  node: NodeRecord;
  issues: IssueRecord[];
}

/** SSE change feed payload (also the POST /api/reload response). */
export interface ChangeEvent {
  revision: number;
  changed: string[];
  deleted: string[];
  /** True on connect and after POST /api/reload: refresh wholesale. */
  reload?: true;
}

/** Editable fields sent on create/update; the id is never editable. When
 * `type` is sent and differs from the current type, the node is converted. */
export interface NodePayload {
  type?: NodeType;
  body: string;
  summary?: string;
  grounds?: string[];
  rationale?: string;
  confirmed?: string;
}

/** Visualization directions, ordered from most abstract to most concrete. */
export type LayoutDirection = "LR" | "TB" | "RL" | "BT";
