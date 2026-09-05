import { getAncestors, getDependents, getGrounds, getSiblings, queryGroups } from "refino";
import type { Graph, NodeLite, QueryGroup, RefinoNode } from "refino";

/**
 * Canvas on-demand query logic over the resident graph (docs/design.md,
 * "画布按需查询"). Pure graph functions: HTTP shaping lives in query-api.ts.
 *
 * All batch queries use partial-success semantics via the engine's
 * `QueryGroup<T>`. Results carry light node shapes (no body): the canvas
 * renders id, type, summary and grounds edges.
 */

export interface NodeWithDepth extends NodeLite {
  /** Distance from the query's anchor node; 0 for the anchor itself. */
  depth: number;
}

/** One id's neighborhood: nearest-first, truncated when over budget. */
export interface Neighborhood {
  truncated: boolean;
  nodes: NodeWithDepth[];
}

/** One id's strong siblings: overlap-descending, truncated when over budget. */
export interface Siblings {
  truncated: boolean;
  nodes: Array<NodeLite & { overlap: number }>;
}

/**
 * Relationship between two range endpoints: ancestor (one reaches the other),
 * branches (different branches, one shortest path per side through their
 * common ancestor; definitive when both ancestor searches completed) or
 * disconnected (budget exhausted before the relationship could be judged).
 * The last two return only the clicked node.
 */
export type RangeMode = "ancestor" | "branches" | "disconnected";

export interface RangeNode extends NodeLite {
  /** Depth from focus; null when the node is unreachable from focus. */
  depth: number | null;
}

export interface RangeResult {
  mode: RangeMode;
  /**
   * Constraints between the endpoints plus the endpoints themselves (kept
   * even when premises), ordered by depth from focusId.
   */
  nodes: RangeNode[];
}

export function toLite(node: RefinoNode): NodeLite {
  return node.type === "constraint"
    ? { id: node.id, type: node.type, summary: node.summary, grounds: node.grounds }
    : { id: node.id, type: node.type, summary: node.summary };
}

/**
 * Per-id neighborhood: the anchor itself at depth 0, ancestors up to
 * `ancestorDepth` (constraints and premises) plus descendants up to
 * `descendantDepth` (constraints only — only constraints carry grounds).
 * Nearest-first; `limit` truncates. The group's `results` array holds
 * exactly one neighborhood object.
 */
export function neighbors(
  graph: Graph,
  ids: readonly string[],
  params: { ancestorDepth: number; descendantDepth: number; limit?: number },
): QueryGroup<Neighborhood>[] {
  return queryGroups(graph, ids, (g, id): Neighborhood[] => {
    const depth = new Map<string, number>([[id, 0]]);
    // Depth-bounded traversals: only the requested generations expand, so a
    // shallow hover does not walk the full ancestor/dependent closure.
    for (const entry of getAncestors(g, id, { maxDepth: params.ancestorDepth })) {
      depth.set(entry.node.id, entry.depth);
    }
    for (const entry of getDependents(g, id, { maxDepth: params.descendantDepth })) {
      const previous = depth.get(entry.node.id);
      if (previous === undefined || entry.depth < previous) depth.set(entry.node.id, entry.depth);
    }
    const sorted = [...depth].sort(byDepthThenId);
    const truncated = params.limit !== undefined && sorted.length > params.limit;
    const kept = truncated ? sorted.slice(0, params.limit) : sorted;
    return [
      {
        truncated,
        nodes: kept.map(([nid, d]) => ({ ...toLite(g.nodes.get(nid)!), depth: d })),
      },
    ];
  });
}

/** Per-id direct grounds (single hop, premises and constraints, declared order). */
export function grounds(graph: Graph, ids: readonly string[]): QueryGroup<NodeLite>[] {
  return queryGroups(graph, ids, (g, id) => getGrounds(g, id).map(toLite));
}

/**
 * Strong siblings: constraints sharing at least one direct ground with the
 * queried node (never the node itself, never premises). Overlap-descending,
 * id-ascending; `limit` truncates. The group's `results` array holds exactly
 * one sibling set object.
 */
export function siblings(
  graph: Graph,
  ids: readonly string[],
  limit?: number,
): QueryGroup<Siblings>[] {
  return queryGroups(graph, ids, (g, id): Siblings[] => {
    const all = getSiblings(g, id);
    const truncated = limit !== undefined && all.length > limit;
    const kept = truncated ? all.slice(0, limit) : all;
    return [
      {
        truncated,
        nodes: kept.map(({ node, overlap }) => ({ ...toLite(node), overlap })),
      },
    ];
  });
}

/** Default expansion budget per endpoint when the caller sends none. */
export const DEFAULT_RANGE_BUDGET = 10_000;

/**
 * Range selection between two endpoints (the canvas's shift+click):
 * ancestor — one endpoint reaches the other, nodes are the constraints on
 * all paths between them plus the endpoints; branches — a single shortest
 * path between the endpoints, each side walking its grounds upstream to the
 * nearest common ancestor (minimal total path length, ties by id); when no
 * common ancestor exists within the budget the result degrades to only the
 * clicked node, definitively (`branches`) if both searches completed,
 * `disconnected` otherwise.
 */
export function range(
  graph: Graph,
  focusId: string,
  clickedId: string,
  budget: number,
): RangeResult {
  const focusAnc = ancestorsWithin(graph, focusId, Math.max(1, budget));
  const clickedAnc = ancestorsWithin(graph, clickedId, Math.max(1, budget - focusAnc.expansions));

  // A node is trivially its own ancestor; treat self-selection as ancestor.
  if (focusId === clickedId || focusAnc.depths.has(clickedId)) {
    return ancestorRange(
      graph,
      focusId,
      clickedId,
      focusId === clickedId ? focusId : clickedId,
      focusAnc,
      clickedAnc,
    );
  }
  if (clickedAnc.depths.has(focusId)) {
    return ancestorRange(graph, focusId, clickedId, focusId, focusAnc, clickedAnc);
  }

  // Nearest common ancestor: minimal total path length, then constraint
  // nodes before premises (a premise LCA would cut both paths short of the
  // constraint structure the selection is about), then id order.
  let lca: string | undefined;
  let best = Infinity;
  let lcaIsPremise = false;
  for (const [id, fromFocus] of focusAnc.depths) {
    const fromClicked = clickedAnc.depths.get(id);
    if (fromClicked === undefined) continue;
    const total = fromFocus + fromClicked;
    const premise = graph.nodes.get(id)?.type !== "constraint";
    const better =
      total < best ||
      (total === best &&
        (lca === undefined ||
          (lcaIsPremise && !premise) ||
          (lcaIsPremise === premise && id < lca)));
    if (better) {
      best = total;
      lca = id;
      lcaIsPremise = premise;
    }
  }
  if (lca !== undefined) {
    const fromFocusLca = focusAnc.depths.get(lca)!;
    const fromClickedLca = clickedAnc.depths.get(lca)!;
    // One shortest path per side, both walked down from the LCA: at each
    // hop the id-ascending direct dependent whose remaining depth to the
    // endpoint is exactly one less (a shorter hop would contradict the BFS
    // depths; a longer one would leave the shortest route).
    const depthFromFocus = new Map<string, number>();
    shortestPathDown(graph, lca, focusId, focusAnc.depths, (id, left) => {
      depthFromFocus.set(id, left);
    });
    shortestPathDown(graph, lca, clickedId, clickedAnc.depths, (id, left) => {
      // d measures up from clicked; the distance from focus runs through
      // the LCA. A node on both sides keeps its smaller (focus-side)
      // distance.
      const total = fromFocusLca + (fromClickedLca - left);
      const previous = depthFromFocus.get(id);
      if (previous === undefined || total < previous) depthFromFocus.set(id, total);
    });
    // Endpoints are kept even when premises.
    depthFromFocus.set(focusId, 0);
    depthFromFocus.set(clickedId, fromFocusLca + fromClickedLca);
    return { mode: "branches", nodes: materialize(graph, depthFromFocus) };
  }

  return {
    mode: focusAnc.complete && clickedAnc.complete ? "branches" : "disconnected",
    nodes: [
      { ...toLite(graph.nodes.get(clickedId)!), depth: clickedAnc.depths.get(focusId) ?? null },
    ],
  };
}

/**
 * Ancestor relationship: constraints on all paths between the endpoints
 * (dependents of the ancestor intersected with the descendant's ancestors)
 * plus both endpoints, ordered by depth from focus.
 */
function ancestorRange(
  graph: Graph,
  focusId: string,
  clickedId: string,
  ancestorId: string,
  focusAnc: BoundedAncestors,
  clickedAnc: BoundedAncestors,
): RangeResult {
  const focusIsAncestor = ancestorId === focusId;
  const descendantId = focusIsAncestor ? clickedId : focusId;
  const descendantAncestors = focusIsAncestor ? clickedAnc.depths : focusAnc.depths;

  const down = getDependents(graph, ancestorId);
  const ids = new Set<string>([ancestorId, descendantId]);
  for (const entry of down) {
    if (descendantAncestors.has(entry.node.id)) ids.add(entry.node.id);
  }

  // Depth from focus for ordering. When focus is the descendant, the paths
  // are all inside its ancestor map. When focus is the ancestor, path nodes
  // take their dependents depth and clicked sits at the focus->clicked
  // distance read from clicked's ancestor search.
  const depthFromFocus = new Map(focusAnc.depths);
  if (focusIsAncestor) {
    for (const entry of down) {
      const previous = depthFromFocus.get(entry.node.id);
      if (previous === undefined || entry.depth < previous)
        depthFromFocus.set(entry.node.id, entry.depth);
    }
    const clickedDepth = clickedAnc.depths.get(focusId);
    if (clickedDepth !== undefined) depthFromFocus.set(clickedId, clickedDepth);
  }
  return { mode: "ancestor", nodes: materialize(graph, depthFromFocus, ids) };
}

/**
 * One shortest constraint path from the LCA down to an endpoint: at each
 * hop the id-ascending direct dependent whose remaining depth to the
 * endpoint is exactly one less. Intermediates need no type filter — a
 * dependent must carry grounds, so premises never appear mid-path. Only
 * constraints are assigned: a premise LCA is neither a constraint nor an
 * endpoint, and the endpoints themselves are the caller's to set.
 */
function shortestPathDown(
  graph: Graph,
  lcaId: string,
  endId: string,
  depths: Map<string, number>,
  assign: (id: string, left: number) => void,
): void {
  let current = lcaId;
  if (graph.nodes.get(current)?.type === "constraint") assign(current, depths.get(current)!);
  while (current !== endId) {
    const remaining = depths.get(current)!;
    let next: string | undefined;
    for (const entry of getDependents(graph, current, { maxDepth: 1 })) {
      if (depths.get(entry.node.id) !== remaining - 1) continue;
      if (next === undefined || entry.node.id < next) next = entry.node.id;
    }
    if (next === undefined) break; // unreachable while the depths agree
    current = next;
    if (graph.nodes.get(current)?.type === "constraint") {
      assign(current, depths.get(current)!);
    }
  }
}

function materialize(
  graph: Graph,
  depthFromFocus: Map<string, number>,
  ids?: Iterable<string>,
): RangeNode[] {
  return [...(ids ?? depthFromFocus.keys())]
    .map((id) => ({ id, depth: depthFromFocus.get(id) }))
    .sort((a, b) => {
      const da = a.depth ?? Number.POSITIVE_INFINITY;
      const db = b.depth ?? Number.POSITIVE_INFINITY;
      return da !== db ? da - db : a.id < b.id ? -1 : 1;
    })
    .map(({ id, depth }) => ({ ...toLite(graph.nodes.get(id)!), depth: depth ?? null }));
}

interface BoundedAncestors {
  /** Id -> depth from the start node; includes the start at depth 0. */
  depths: Map<string, number>;
  /** False when the budget ran out before the full ancestor set was known. */
  complete: boolean;
  expansions: number;
}

/**
 * Breadth-first ancestor search along grounds edges, counting expansions
 * against the budget so range queries stay bounded at scale. Traversal order
 * (by depth, then declared grounds order) is deterministic.
 */
function ancestorsWithin(graph: Graph, start: string, budget: number): BoundedAncestors {
  const depths = new Map<string, number>([[start, 0]]);
  const queue: string[] = [start];
  let expansions = 0;
  let complete = true;
  for (let head = 0; head < queue.length; head++) {
    if (expansions >= Math.max(1, budget)) {
      complete = false;
      break;
    }
    const current = queue[head]!;
    const depth = depths.get(current)!;
    expansions++;
    const node = graph.nodes.get(current);
    const grounds = node?.type === "constraint" ? node.grounds : [];
    for (const ground of grounds) {
      if (!depths.has(ground)) {
        depths.set(ground, depth + 1);
        queue.push(ground);
      }
    }
  }
  return { depths, complete, expansions };
}

function byDepthThenId(a: [string, number], b: [string, number]): number {
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}
