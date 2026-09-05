import type { NodeWithDepth, RefinoNode } from "refino";

/**
 * Canonical tool-result shapes (docs/design.md, dsh 插件落地形态). Loose on
 * purpose where values cross the tool schema boundary: the schema-inferred
 * render inputs carry plain `string` where the domain model has unions.
 */

/** Summary-level node reference used by list/grounds/pending results. */
export interface NodeLite {
  id: string;
  type: string;
  summary: string;
}

export interface NodeDepthLite extends NodeLite {
  depth: number;
}

/** Full editable node content returned by `refino_show`. */
export interface FullNodeLite {
  id: string;
  type: string;
  summary: string;
  body: string;
  rationale?: string;
  grounds?: string[];
  confirmed?: string;
}

export interface IssueLite {
  code: string;
  message: string;
}

/**
 * Structured escalation report for a blocked write (docs/crg.md 3.4): the
 * target itself sits in the frozen zone. The modification space closes
 * downwards along dependents, so no other escalation reason exists. The
 * model is expected to stop modifying, report to the user, and propose
 * changes — not to retry.
 */
export interface EscalationLite {
  id: string;
  reason: "node_frozen";
  affected: NodeDepthLite[];
}

/** Canonical value of the write tools; `ok: false` carries exactly one failure facet. */
export interface WriteResult {
  ok: boolean;
  /** The created/updated/deleted node id on success. */
  id?: string;
  /** Constraints now pending review as a consequence of the change. */
  pending?: NodeLite[];
  /** Failure reason (validation, storage error, or refusal). */
  error?: string;
  /** Engine grounds-validation issues for rejected grounds changes. */
  issues?: IssueLite[];
  /** Boundary escalation for writes reaching the frozen zone. */
  escalation?: EscalationLite;
  /** Existing downstream constraints (delete refusal). */
  dependents?: NodeLite[];
}

export interface ListResult {
  total: number;
  issue_count: number;
  nodes: NodeLite[];
}

export interface QueryEntryNodes {
  id: string;
  nodes?: NodeLite[];
  error?: string;
}

export interface QueryEntryDepths {
  id: string;
  nodes?: NodeDepthLite[];
  error?: string;
}

export interface QueryEntryFull {
  id: string;
  node?: FullNodeLite;
  error?: string;
}

export interface PendingResult {
  pending: NodeLite[];
  unknown_ids: string[];
}

/** Canonical value of `refino_search`: one keyset page over the graph. */
export interface SearchResult {
  query: string;
  nodes: NodeLite[];
  /** Id after which to continue; absent on the last page. */
  next_cursor?: string;
}

/** Strong sibling of the queried node: shares `overlap` direct grounds. */
export interface SiblingLite extends NodeLite {
  overlap: number;
}

export interface QueryEntrySiblings {
  id: string;
  nodes?: SiblingLite[];
  error?: string;
}

export interface SiblingsResult {
  results: QueryEntrySiblings[];
}

export function lite(node: RefinoNode): NodeLite {
  return { id: node.id, type: node.type, summary: node.summary };
}

export function depthLite(entry: NodeWithDepth): NodeDepthLite {
  return { ...lite(entry.node), depth: entry.depth };
}

export function fullLite(node: RefinoNode): FullNodeLite {
  const base = { id: node.id, type: node.type, summary: node.summary, body: node.body };
  return node.type === "premise"
    ? { ...base, ...(node.confirmed !== undefined ? { confirmed: node.confirmed } : {}) }
    : {
        ...base,
        grounds: node.grounds,
        ...(node.rationale !== undefined ? { rationale: node.rationale } : {}),
      };
}

export function issueLite(issue: { code: unknown; message: string }): IssueLite {
  return { code: String(issue.code), message: issue.message };
}
