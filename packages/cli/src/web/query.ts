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

/**
 * Relationship between two range endpoints: ancestor (one reaches the
 * other), branches (different branches, one shortest path per side through
 * their common ancestor) or disconnected (no common ancestor — definitively
 * unrelated endpoints, or the budget ran out before one could be found).
 * Disconnected results carry only the clicked node.
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
 * Per-id expansion block: the unit the canvas working set grows by. The
 * anchor's full upstream closure, `descendantDepth` generations of
 * constraints downstream (unbounded when omitted — the canvas cold start
 * walks down from the roots until the limit), strong siblings (undirected
 * distance 2 via a shared ground), and the upstream closure of every block
 * constraint — so each rendered edge has both ends on the canvas.
 * Nearest-first; `limit` truncates and caps traversal. The group's
 * `results` array holds exactly one expansion object.
 */
export interface Expansion {
  truncated: boolean;
  nodes: NodeWithDepth[];
}

export interface ExpandParams {
  /**
   * Descendant constraint generations per anchor; unbounded when omitted.
   */
  descendantDepth?: number;
  /** Whether strong siblings of the anchor join the block. */
  showSiblings: boolean;
  /** Sibling candidates kept per anchor (overlap-descending, id-ascending). */
  siblingLimit?: number;
  /** Per-block truncation limit (nearest-first) and traversal cap. */
  limit?: number;
}

export function expand(
  graph: Graph,
  ids: readonly string[],
  params: ExpandParams,
): QueryGroup<Expansion>[] {
  return queryGroups(graph, ids, (g, id): Expansion[] => [expandOne(g, id, params)]);
}

function expandOne(graph: Graph, id: string, params: ExpandParams): Expansion {
  const depth = new Map<string, number>([[id, 0]]);

  // Downstream constraints (only constraints carry grounds), nearest-first
  // min-depth merge. Omitted depth walks the full descendant closure.
  const maxDepth = params.descendantDepth;
  for (const entry of getDependents(graph, id, maxDepth === undefined ? {} : { maxDepth })) {
    const previous = depth.get(entry.node.id);
    if (previous === undefined || entry.depth < previous) depth.set(entry.node.id, entry.depth);
  }

  // Upstream sources: the anchor at 0, every downstream node at its depth
  // (its side grounds must close), strong siblings at 2. Ascending order
  // lets the nearest source claim nodes first, keeping depths minimal.
  const seeds: Array<[string, number]> = [[id, 0]];
  for (const [nodeId, d] of depth) {
    if (nodeId !== id) seeds.push([nodeId, d]);
  }
  if (params.showSiblings) {
    const all = getSiblings(graph, id);
    const kept =
      params.siblingLimit !== undefined ? all.slice(0, Math.max(0, params.siblingLimit)) : all;
    for (const { node } of kept) seeds.push([node.id, 2]);
  }
  seeds.sort(byDepthThenId);

  const { capped } = upstreamClosure(graph, seeds, depth, params.limit);

  const limit = params.limit;
  const sorted = [...depth].sort(byDepthThenId);
  const truncated = limit !== undefined && sorted.length > limit;
  const kept = truncated ? sorted.slice(0, Math.max(0, limit)) : sorted;
  return {
    truncated: truncated || capped,
    nodes: kept.map(([nid, d]) => ({ ...toLite(graph.nodes.get(nid)!), depth: d })),
  };
}

/** Default expansion budget per endpoint when the caller sends none. */
export const DEFAULT_RANGE_BUDGET = 10_000;

/**
 * Range selection between two endpoints (the canvas's shift+click):
 * ancestor — one endpoint reaches the other, nodes are the constraints on
 * all paths between them plus the endpoints; branches — a single shortest
 * path between the endpoints, each side walking its grounds upstream to the
 * nearest common ancestor (minimal total path length, ties by id);
 * disconnected — no common ancestor exists within the budget (definitively
 * unrelated endpoints, or the budget ran out before one could be found) and
 * the result degrades to only the clicked node.
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
    mode: "disconnected",
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
  expansions: number;
}

/**
 * Breadth-first ancestor search along grounds edges, counting expansions
 * against the budget so range queries stay bounded at scale. Traversal order
 * (by depth, then declared grounds order) is deterministic.
 */
function ancestorsWithin(graph: Graph, start: string, budget: number): BoundedAncestors {
  const depths = new Map<string, number>([[start, 0]]);
  const { expansions } = upstreamClosure(graph, [[start, 0]], depths, Math.max(1, budget));
  return { depths, expansions };
}

/**
 * Multi-source upstream closure over grounds edges (only constraints carry
 * them). Sources are processed in ascending seed-depth order; each runs one
 * breadth-first walk merging minimal depths into `depths`. A ground already
 * mapped stays unexpanded — an earlier (nearer) source merged its chain
 * already, or the cap truncated the traversal — while a mapped seed still
 * walks, since only its own source closes its grounds. `cap` bounds total
 * expansions (dequeues); `capped` reports an early stop, in which case the
 * closure is incomplete. Depth values are advisory: they order nearest-first
 * truncation, they are not consumed downstream.
 */
function upstreamClosure(
  graph: Graph,
  seeds: ReadonlyArray<[string, number]>,
  depths: Map<string, number>,
  cap: number | undefined,
): { expansions: number; capped: boolean } {
  const limit = cap === undefined ? undefined : Math.max(1, cap);
  let expansions = 0;
  for (const [seedId, base] of seeds) {
    const previous = depths.get(seedId);
    if (previous === undefined || base < previous) depths.set(seedId, base);
    if (limit !== undefined && expansions >= limit) return { expansions, capped: true };
    const queue: Array<[string, number]> = [[seedId, depths.get(seedId)!]];
    const visited = new Set<string>([seedId]);
    let capped = false;
    for (let head = 0; head < queue.length; head++) {
      if (limit !== undefined && expansions >= limit) {
        capped = true;
        break;
      }
      const [current, depth] = queue[head]!;
      expansions++;
      const node = graph.nodes.get(current);
      for (const ground of node?.type === "constraint" ? node.grounds : []) {
        if (!graph.nodes.has(ground) || visited.has(ground)) continue;
        visited.add(ground);
        if (!depths.has(ground)) depths.set(ground, depth + 1);
        queue.push([ground, depth + 1]);
      }
    }
    if (capped) return { expansions, capped: true };
  }
  return { expansions, capped: false };
}

function byDepthThenId(a: [string, number], b: [string, number]): number {
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}
