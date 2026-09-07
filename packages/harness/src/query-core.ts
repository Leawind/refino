import {
  getAncestors,
  getDependents,
  getGrounds,
  getSiblings,
  queryGroups,
  requireNode,
  type NodeWithDepth,
  type RefinoNode,
  type TraversalOptions,
} from "refino";
import { pendingReview } from "./pending.js";
import {
  depthLite,
  fullLite,
  lite,
  type ListResult,
  type PendingResult,
  type QueryEntryDepths,
  type QueryEntryFull,
  type QueryEntryNodes,
  type QueryEntrySiblings,
  type SearchResult,
  type SiblingsResult,
} from "./shapes.js";
import type { RefinoWorkspace } from "./workspace.js";

/**
 * Read-only CRG tool cores (docs/design.md, 模型侧：CRG 访问工具): batch,
 * partial-success semantics over one workspace. Host adapters (dsh native
 * tools, MCP servers) declare their schemas and delegate here, so query
 * semantics stay single-sourced across integration forms.
 */

export function runList(ws: RefinoWorkspace, type?: RefinoNode["type"]): ListResult {
  const nodes = ws.session.listNodes(type);
  return {
    total: nodes.length,
    issue_count: ws.issues.length,
    nodes: nodes.map(lite),
  };
}

export function runSearch(
  ws: RefinoWorkspace,
  params: { q?: string; type?: RefinoNode["type"]; limit?: number; cursor?: string },
): SearchResult {
  return ws.session.search(params);
}

export async function runShow(
  ws: RefinoWorkspace,
  ids: readonly string[],
): Promise<{
  results: QueryEntryFull[];
}> {
  const groups = queryGroups(ws.graph, ids, (graph, id) => [requireNode(graph, id)]);
  const results: QueryEntryFull[] = [];
  for (const group of groups) {
    if ("error" in group) {
      results.push({ id: group.id, error: group.error });
      continue;
    }
    // Body and rationale are paged content; fetch them per id.
    const content = await ws.content(group.id);
    results.push({ id: group.id, node: fullLite(group.results[0]!, content) });
  }
  return { results };
}

export function runGrounds(
  ws: RefinoWorkspace,
  ids: readonly string[],
): { results: QueryEntryNodes[] } {
  const groups = queryGroups(ws.graph, ids, (graph, id) => getGrounds(graph, id));
  return { results: groups.map(toNodesEntry) };
}

export function runAncestors(
  ws: RefinoWorkspace,
  ids: readonly string[],
  maxDepth?: number,
): { results: QueryEntryDepths[] } {
  const options = traversalOptions(maxDepth);
  const groups = queryGroups(ws.graph, ids, (graph, id) => getAncestors(graph, id, options));
  return { results: groups.map(toDepthsEntry) };
}

export function runDependents(
  ws: RefinoWorkspace,
  ids: readonly string[],
  maxDepth?: number,
): { results: QueryEntryDepths[] } {
  const options = traversalOptions(maxDepth);
  const groups = queryGroups(ws.graph, ids, (graph, id) => getDependents(graph, id, options));
  return { results: groups.map(toDepthsEntry) };
}

export function runSiblings(
  ws: RefinoWorkspace,
  ids: readonly string[],
  limit?: number,
): SiblingsResult {
  const groups = queryGroups(ws.graph, ids, (graph, id) => {
    const all = getSiblings(graph, id);
    const kept = limit === undefined ? all : all.slice(0, limit);
    return kept.map(({ node, overlap }) => ({ ...lite(node), overlap }));
  });
  const results: QueryEntrySiblings[] = groups.map((group) =>
    "error" in group
      ? { id: group.id, error: group.error }
      : { id: group.id, nodes: group.results },
  );
  return { results };
}

export function runPendingReview(
  ws: RefinoWorkspace,
  changedIds: readonly string[],
): PendingResult {
  const known = ws.graph.nodes;
  const changedKnown = changedIds.filter((id) => known.has(id));
  const pending = changedKnown.length > 0 ? pendingReview(ws.graph, changedKnown) : [];
  return {
    pending: pending.map(lite),
    unknown_ids: changedIds.filter((id) => !known.has(id)),
  };
}

/**
 * Hand-checked traversal bound the hosts' schema DSLs cannot express: an
 * invalid depth throws (the host surfaces it as a tool error), matching the
 * dsh behavior this core was extracted from.
 */
function traversalOptions(maxDepth: number | undefined): TraversalOptions {
  if (maxDepth === undefined) return {};
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new Error(`max_depth must be a non-negative integer, got ${maxDepth}`);
  }
  return { maxDepth };
}

function toNodesEntry(
  group: { id: string } & ({ results: RefinoNode[] } | { error: string }),
): QueryEntryNodes {
  return "error" in group
    ? { id: group.id, error: group.error }
    : { id: group.id, nodes: group.results.map(lite) };
}

function toDepthsEntry(
  group: { id: string } & ({ results: NodeWithDepth[] } | { error: string }),
): QueryEntryDepths {
  return "error" in group
    ? { id: group.id, error: group.error }
    : { id: group.id, nodes: group.results.map(depthLite) };
}
