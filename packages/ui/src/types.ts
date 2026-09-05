/** Shared front-end types mirroring the JSON API contract (docs/design.md,
 * "后端 API 契约" and "画布按需查询"). Shapes the engine already owns are
 * imported from `refino` instead of redeclared here, so the wire contract
 * cannot drift from the engine.
 *
 * Deliberately local: NodeRecord/NodePayload mirror the HTTP record, whose
 * optionality differs from the engine's in-memory node union. */

import type { NodeLite, NodeType, RefinoIssue } from "refino";

export type { NodeType, NodeLite, QueryGroup, RefinoIssue } from "refino";
/** Issues as emitted by the API — the engine's `RefinoIssue` JSON. */
export type IssueRecord = RefinoIssue;

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

/** Full node record as exposed by GET /api/nodes/:id. Confirmed is epoch
 * milliseconds on the wire; the storage layer keeps RFC 3339 in the files. */
export interface NodeRecord {
  id: string;
  type: NodeType;
  summary: string;
  body: string;
  grounds?: string[];
  rationale?: string;
  confirmed?: number;
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
  /** Write entry that produced this batch; absent on snapshot/reload frames. */
  origin?: "api" | "file";
  /** True on connect and after POST /api/reload: refresh wholesale. */
  reload?: true;
}

/** Editable fields sent on create/update; the id is never editable. `type`
 * is required when PUT creates a node under a free id (recreating an
 * externally deleted node); an existing node's type cannot change. */
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

export type Theme = "light" | "dark";
export type Locale = "zh" | "en";
