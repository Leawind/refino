import { IssueCode, RefinoError } from "refino";
import type { Context } from "hono";
import type { GraphIndex } from "./graph-index.js";
import * as query from "./query.js";
import { errorResponse, INVALID_REQUEST, readPayload } from "./api.js";

/**
 * Canvas on-demand query endpoints (docs/design.md, "画布按需查询") and the
 * paginated sidebar search. Handlers assume the index is ready.
 */

/** Batch responses answer 200 when every id resolved, 207 (Multi-Status) when any group carries a per-id error. */
function batchStatus(groups: ReadonlyArray<unknown>): 200 | 207 {
  return groups.some((group) => typeof group === "object" && group !== null && "error" in group)
    ? 207
    : 200;
}

/** POST /api/query/neighbors — per-id bounded neighborhoods, nearest-first. */
export async function postQueryNeighbors(c: Context, index: GraphIndex): Promise<Response> {
  try {
    const payload = await readPayload(c);
    const ids = readIds(payload);
    const ancestorDepth = readNonNegativeInt(payload, "ancestorDepth");
    const descendantDepth = readNonNegativeInt(payload, "descendantDepth");
    const limit = readOptionalLimit(payload);
    const groups = query.neighbors(index.graph, ids, { ancestorDepth, descendantDepth, limit });
    return c.json(groups, batchStatus(groups));
  } catch (error) {
    return errorResponse(c, error);
  }
}

/** POST /api/query/grounds — per-id direct grounds, single hop. */
export async function postQueryGrounds(c: Context, index: GraphIndex): Promise<Response> {
  try {
    const payload = await readPayload(c);
    const groups = query.grounds(index.graph, readIds(payload));
    return c.json(groups, batchStatus(groups));
  } catch (error) {
    return errorResponse(c, error);
  }
}

/** POST /api/query/range — relationship and path nodes between two endpoints. */
export async function postQueryRange(c: Context, index: GraphIndex): Promise<Response> {
  try {
    const payload = await readPayload(c);
    const focusId = readIdField(payload, "focusId");
    const clickedId = readIdField(payload, "clickedId");
    for (const id of [focusId, clickedId]) {
      if (index.entry(id) === undefined) {
        throw new RefinoError(IssueCode.NodeNotFound, `Node "${id}" does not exist.`);
      }
    }
    const budget =
      payload.budget === undefined
        ? query.DEFAULT_RANGE_BUDGET
        : readNonNegativeInt(payload, "budget");
    return c.json(query.range(index.graph, focusId, clickedId, budget));
  } catch (error) {
    return errorResponse(c, error);
  }
}

/** POST /api/query/siblings — per-id strong siblings by shared direct grounds. */
export async function postQuerySiblings(c: Context, index: GraphIndex): Promise<Response> {
  try {
    const payload = await readPayload(c);
    const groups = query.siblings(index.graph, readIds(payload), readOptionalLimit(payload));
    return c.json(groups, batchStatus(groups));
  } catch (error) {
    return errorResponse(c, error);
  }
}

const SEARCH_DEFAULT_LIMIT = 50;
const SEARCH_MAX_LIMIT = 500;

/**
 * GET /api/search — keyset pagination over the ascending id view; `cursor`
 * is the id after which to continue. `q` matches id prefixes (case
 *-insensitive; ids are Crockford base32) and summary substrings. `roots`
 * restricts to root constraints (grounds-less), the cold-start overview's
 * entry points.
 */
export async function getSearch(c: Context, index: GraphIndex): Promise<Response> {
  try {
    const q = (c.req.query("q") ?? "").trim();
    const type = c.req.query("type");
    if (type !== undefined && type !== "premise" && type !== "constraint") {
      throw new RefinoError(INVALID_REQUEST, `"type" must be "premise" or "constraint".`);
    }
    const roots = c.req.query("roots");
    const rootsOnly = roots === "1" || roots === "true";
    const unreferenced = c.req.query("unreferenced");
    const unreferencedOnly = unreferenced === "1" || unreferenced === "true";
    const rawLimit = Number(c.req.query("limit"));
    const limit = Number.isInteger(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), SEARCH_MAX_LIMIT)
      : SEARCH_DEFAULT_LIMIT;
    const cursor = c.req.query("cursor") || undefined;

    const all = index.sortedIds();
    const qUpper = q.toUpperCase();
    const qLower = q.toLowerCase();
    const matched: string[] = [];
    for (let i = startIndex(all, cursor); i < all.length && matched.length <= limit; i++) {
      const id = all[i]!;
      const entry = index.entry(id)!;
      if (type !== undefined && entry.node.type !== type) continue;
      if (rootsOnly && (entry.node.type !== "constraint" || entry.node.grounds.length > 0)) {
        continue;
      }
      // Premises no constraint grounds on (the CLI's list --unreferenced):
      // candidates for review or removal in maintenance work.
      if (unreferencedOnly && (entry.node.type !== "premise" || entry.node.children.length > 0)) {
        continue;
      }
      if (
        qUpper !== "" &&
        !id.toUpperCase().startsWith(qUpper) &&
        !entry.node.summary.toLowerCase().includes(qLower)
      ) {
        continue;
      }
      matched.push(id);
    }
    const page = matched.length > limit ? matched.slice(0, limit) : matched;
    return c.json({
      nodes: page.map((id) => {
        const node = index.entry(id)!.node;
        return { id, type: node.type, summary: node.summary };
      }),
      nextCursor: matched.length > limit ? page[page.length - 1] : undefined,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

/** GET /api/stats — counts for the project-overview cold start. */
export async function getStats(c: Context, index: GraphIndex): Promise<Response> {
  return c.json({ revision: index.revision, ...index.stats() });
}

/** GET /api/pending — constraints pending review since the last reload / service start. */
export async function getPending(c: Context, index: GraphIndex): Promise<Response> {
  return c.json({
    revision: index.revision,
    nodes: index.pending().map((node) => ({ id: node.id, type: node.type, summary: node.summary })),
  });
}

/** First index position at or after the cursor; keyset pages resume strictly after it. */
function startIndex(all: readonly string[], cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  let lo = 0;
  let hi = all.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (all[mid]! < cursor) lo = mid + 1;
    else hi = mid;
  }
  return all[lo] === cursor ? lo + 1 : lo;
}

function readIds(payload: Record<string, unknown>): string[] {
  const ids = payload.ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    throw new RefinoError(INVALID_REQUEST, `"ids" must be an array of node ids.`);
  }
  return [...new Set(ids as string[])];
}

function readIdField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") {
    throw new RefinoError(INVALID_REQUEST, `"${key}" is required and must be a string.`);
  }
  return value;
}

function readNonNegativeInt(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RefinoError(INVALID_REQUEST, `"${key}" must be a non-negative integer.`);
  }
  return value;
}

function readOptionalLimit(payload: Record<string, unknown>): number | undefined {
  if (payload.limit === undefined || payload.limit === null) return undefined;
  return readNonNegativeInt(payload, "limit");
}
