import {
  createConstraint,
  createPremise,
  deleteNode,
  loadGraph,
  updateConstraint,
  updatePremise,
} from "@refino/storage";
import { getAncestors, getDependents, ID_RE, RefinoError, validateGraph } from "refino";
import type { Graph, RefinoNode } from "refino";
import type { Context } from "hono";

/**
 * Read/write JSON API over a `.refino` directory. All endpoints return JSON;
 * errors are `{ error: string, issues?: RefinoIssue[] }` with a mapped status
 * code. Grounds reference validity and cycles are checked before writing so
 * the stored files never become invalid through the API.
 */

export interface GraphApiOptions {
  refinoDir: string;
}

/** The node record as exposed over the API. */
export function nodeJson(node: RefinoNode): Record<string, unknown> {
  return {
    id: node.id,
    type: node.type,
    file: node.file,
    summary: node.summary,
    body: node.body,
    ...(node.type === "constraint" && { grounds: node.grounds ?? [] }),
    ...(node.type === "constraint" &&
      node.rationale !== undefined && { rationale: node.rationale }),
    ...(node.type === "premise" && node.confirmed !== undefined && { confirmed: node.confirmed }),
  };
}

/** GET /api/graph — all nodes, validation issues and per-node dependents. */
export async function getGraph(c: Context, opts: GraphApiOptions): Promise<Response> {
  try {
    const { graph, issues } = await loadGraph(opts.refinoDir);
    issues.push(...validateGraph(graph));
    return c.json({
      refinoDir: graph.refinoDir,
      issues,
      nodes: sortedNodes(graph).map((node) => ({
        ...nodeJson(node),
        dependents: graph.dependents.get(node.id) ?? [],
      })),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

/** GET /api/validate — issues only, with a derived ok flag. */
export async function getValidate(c: Context, opts: GraphApiOptions): Promise<Response> {
  try {
    const { issues } = await load(opts.refinoDir);
    return c.json({ ok: issues.length === 0, issues });
  } catch (error) {
    return errorResponse(c, error);
  }
}

interface NodePayload {
  body?: unknown;
  summary?: unknown;
  grounds?: unknown;
  rationale?: unknown;
  confirmed?: unknown;
}

/** POST /api/nodes/premise — create a premise from a JSON payload. */
export async function postPremise(c: Context, opts: GraphApiOptions): Promise<Response> {
  return create(c, opts, "premise");
}

/** POST /api/nodes/constraint — create a constraint from a JSON payload. */
export async function postConstraint(c: Context, opts: GraphApiOptions): Promise<Response> {
  return create(c, opts, "constraint");
}

async function create(
  c: Context,
  opts: GraphApiOptions,
  type: "premise" | "constraint",
): Promise<Response> {
  try {
    const payload = await readPayload(c);
    const body = readRequiredString(payload, "body");
    const summary = readString(payload, "summary");
    const id =
      type === "premise"
        ? await createPremise(opts.refinoDir, {
            body,
            summary,
            confirmed: readString(payload, "confirmed"),
          })
        : await createConstraint(opts.refinoDir, {
            body,
            summary,
            rationale: readString(payload, "rationale"),
            grounds: await readGrounds(c, opts, payload),
          });
    return c.json({ id }, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
}

/** PUT /api/nodes/:id — replace the editable fields of an existing node. */
export async function putNode(c: Context, opts: GraphApiOptions): Promise<Response> {
  try {
    const id = requireParam(c);
    const { graph } = await load(opts.refinoDir);
    const node = graph.nodes.get(id);
    if (node === undefined) {
      throw new RefinoError("NODE_NOT_FOUND", `Node "${id}" does not exist.`);
    }
    const payload = await readPayload(c);
    const body = readRequiredString(payload, "body");
    const summary = readString(payload, "summary");
    if (node.type === "premise") {
      await updatePremise(opts.refinoDir, id, {
        body,
        summary,
        confirmed: readString(payload, "confirmed") ?? node.confirmed,
      });
    } else {
      await updateConstraint(opts.refinoDir, id, {
        body,
        summary,
        rationale: readString(payload, "rationale") ?? node.rationale,
        grounds: (await readGrounds(c, opts, payload)) ?? [],
      });
    }
    return c.json({ id });
  } catch (error) {
    return errorResponse(c, error);
  }
}

/** DELETE /api/nodes/:id — refuse while transitive dependents reference the node. */
export async function removeNode(c: Context, opts: GraphApiOptions): Promise<Response> {
  try {
    const id = requireParam(c);
    const { graph } = await load(opts.refinoDir);
    if (!graph.nodes.has(id)) {
      throw new RefinoError("NODE_NOT_FOUND", `Node "${id}" does not exist.`);
    }
    const affected = getDependents(graph, id);
    if (affected.length > 0) {
      return c.json(
        {
          error: `Node "${id}" is still referenced by ${affected.length} downstream constraint(s).`,
          dependents: affected.map((entry) => ({ id: entry.node.id, depth: entry.depth })),
        },
        409,
      );
    }
    await deleteNode(opts.refinoDir, id);
    return c.json({ id });
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function load(refinoDir: string): Promise<ReturnType<typeof loadGraph>> {
  const result = await loadGraph(refinoDir);
  result.issues.push(...validateGraph(result.graph));
  return result;
}

/**
 * Validate `grounds` before writing: every referenced id must exist, and the
 * change must not close a cycle (the id must not be reachable from any of its
 * new grounds).
 */
async function readGrounds(
  c: Context,
  opts: GraphApiOptions,
  payload: NodePayload,
): Promise<string[] | undefined> {
  if (payload.grounds === undefined) return undefined;
  if (
    !Array.isArray(payload.grounds) ||
    payload.grounds.some((g) => typeof g !== "string" || !ID_RE.test(g))
  ) {
    throw new RefinoError("INVALID_GROUNDS", "grounds must be an array of node ids.");
  }
  const grounds = [...new Set(payload.grounds as string[])];
  const { graph } = await load(opts.refinoDir);
  const missing = grounds.find((g) => !graph.nodes.has(g));
  if (missing !== undefined) {
    throw new RefinoError("UNKNOWN_GROUND", `Ground "${missing}" does not exist.`);
  }
  const target = c.req.param("id");
  if (target !== undefined) {
    for (const ground of grounds) {
      if (ground === target || getAncestors(graph, ground).some((a) => a.node.id === target)) {
        throw new RefinoError("CYCLE", `Grounding "${target}" by "${ground}" would close a cycle.`);
      }
    }
  }
  return grounds;
}

async function readPayload(c: Context): Promise<NodePayload> {
  const payload: unknown = await c.req.json().catch(() => {
    throw new RefinoError("INVALID_FRONTMATTER", "Request body must be valid JSON.");
  });
  if (typeof payload !== "object" || payload === null) {
    throw new RefinoError("INVALID_FRONTMATTER", "Request body must be a JSON object.");
  }
  return payload as NodePayload;
}

function requireParam(c: Context): string {
  const id = c.req.param("id");
  if (id === undefined) {
    throw new RefinoError("NODE_NOT_FOUND", "Node id is required.");
  }
  return id;
}

function readRequiredString(payload: NodePayload, key: keyof NodePayload): string {
  const value = payload[key];
  if (typeof value !== "string") {
    throw new RefinoError("INVALID_FRONTMATTER", `"${key}" is required and must be a string.`);
  }
  return value;
}

function readString(payload: NodePayload, key: keyof NodePayload): string | undefined {
  const value = payload[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new RefinoError("INVALID_FRONTMATTER", `"${key}" must be a string.`);
  }
  return value;
}

function sortedNodes(graph: Graph): RefinoNode[] {
  return [...graph.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Map errors to HTTP responses; RefinoIssue-bearing errors carry their issues. */
function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof RefinoError) {
    return c.json({ error: error.message }, errorStatus(error.code));
  }
  throw error;
}

function errorStatus(code: RefinoError["code"]): 400 | 404 {
  if (code === "NODE_NOT_FOUND" || code === "REFINO_DIR_NOT_FOUND") return 404;
  return 400;
}
