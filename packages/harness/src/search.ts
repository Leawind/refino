import type { Graph, NodeType } from "refino";

/**
 * Keyset-paginated node search over the in-memory graph (docs/design.md,
 * "模型侧：CRG 访问工具" `search`): id prefixes match case-insensitively
 * (ids are Crockford base32), summary substrings case-insensitively. Pure
 * projection over the light fields, so the same shape serves any tool host;
 * the `refino web` server keeps its own index-backed variant with identical
 * matching semantics.
 */

export interface SearchParams {
  /** Match id prefixes and summary substrings; empty matches everything. */
  q?: string;
  /** Restrict to one node type. */
  type?: NodeType;
  /** Page size; defaults to 50, clamped to [1, 500]. */
  limit?: number;
  /** Keyset cursor: resume strictly after this id. */
  cursor?: string;
}

export interface SearchPage {
  /** The query as received, for echo in tool results. */
  query: string;
  nodes: Array<{ id: string; type: NodeType; summary: string }>;
  /** Id after which to continue; absent on the last page. */
  next_cursor?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export function searchNodes(graph: Graph, params: SearchParams = {}): SearchPage {
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const qUpper = (params.q ?? "").trim().toUpperCase();
  const qLower = qUpper.toLowerCase();

  const ids = [...graph.nodes.keys()].sort();
  const start = startIndex(ids, params.cursor);
  const matched: SearchPage["nodes"] = [];
  for (let i = start; i < ids.length && matched.length <= limit; i++) {
    const id = ids[i]!;
    const node = graph.nodes.get(id)!;
    if (params.type !== undefined && node.type !== params.type) continue;
    if (
      qUpper !== "" &&
      !id.toUpperCase().startsWith(qUpper) &&
      !node.summary.toLowerCase().includes(qLower)
    ) {
      continue;
    }
    matched.push({ id, type: node.type, summary: node.summary });
  }
  const hasMore = matched.length > limit;
  const page = hasMore ? matched.slice(0, limit) : matched;
  return {
    query: params.q ?? "",
    nodes: page,
    ...(hasMore && page.length > 0 && { next_cursor: page[page.length - 1]!.id }),
  };
}

/** First index position strictly after the cursor; unknown cursors resume at the next id in order. */
function startIndex(ids: readonly string[], cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  let lo = 0;
  let hi = ids.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ids[mid]! <= cursor) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
