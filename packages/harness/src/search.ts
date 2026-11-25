import type { NodeContent } from "@refino/storage";
import type { Graph, NodeType } from "refino";

/**
 * Keyset-paginated node search over the in-memory graph plus the paged
 * content: id prefixes match case-insensitively (ids are Crockford base32);
 * summary, body and rationale substrings match case-insensitively. Content is
 * read lazily — a node that already matched on its id or summary is not
 * loaded. The same matching semantics serve the CLI search and the web search
 * endpoint.
 */

export interface SearchParams {
  /** Match id prefixes, summary, body and rationale substrings; empty matches everything. */
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

export async function searchNodes(
  graph: Graph,
  params: SearchParams,
  readContent: (id: string) => Promise<NodeContent | undefined>,
): Promise<SearchPage> {
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
    if (qUpper !== "" && !matchesCheaply(id, node.summary, qUpper, qLower)) {
      const content = await readContent(id);
      if (!matchesContent(content, qLower)) continue;
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

/** Id-prefix and summary matching; the cheap half that needs no content read. */
function matchesCheaply(id: string, summary: string, qUpper: string, qLower: string): boolean {
  return id.toUpperCase().startsWith(qUpper) || summary.toLowerCase().includes(qLower);
}

function matchesContent(content: NodeContent | undefined, qLower: string): boolean {
  if (content === undefined) return false;
  return (
    content.body.toLowerCase().includes(qLower) ||
    (content.rationale !== undefined && content.rationale.toLowerCase().includes(qLower))
  );
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
