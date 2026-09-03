import {
  createConstraint,
  createPremise,
  deleteNode,
  updateConstraint,
  updatePremise,
} from "@refino/storage";
import { checkGroundsChange, getAncestors, getDependents, ID_RE, RefinoError } from "refino";
import type { Context } from "hono";
import type { GraphIndex } from "./graph-index.js";

/**
 * Read/write JSON API over the resident graph index. All endpoints return
 * JSON; errors are `{ error: string, issues?: RefinoIssue[] }` with a mapped
 * status code. Handlers assume the index is ready (the server awaits
 * `index.ready()` before dispatching).
 *
 * Grounds reference validity and cycles are checked before writing so the
 * stored files never become invalid through the API. Same-type updates
 * validate through the engine's `checkGroundsChange` primitive (docs/design.md,
 * "引擎提供的共享原语"); type conversion cannot use it (the primitive assumes
 * the target keeps its type, and a premise target with grounds is rejected)
 * so it checks existence and reachability against the index directly.
 */

/** The node record as exposed over the API. */
export function nodeJson(
  node: { id: string; type: string; summary: string } & Record<string, unknown>,
): Record<string, unknown> {
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

/** GET /api/graph — all nodes, validation issues and per-node dependents (compatibility endpoint; the canvas uses /api/query/*). */
export async function getGraph(c: Context, index: GraphIndex): Promise<Response> {
  try {
    const graph = index.graph;
    const nodes = [...graph.nodes.values()].sort(byId);
    const bodies = await Promise.all(nodes.map((node) => index.readBody(node.id)));
    return c.json({
      refinoDir: graph.refinoDir,
      revision: index.revision,
      issues: index.issues(),
      nodes: nodes.map((node, i) => ({
        ...nodeJson({ ...node, body: bodies[i] ?? "" }),
        dependents: graph.dependents.get(node.id) ?? [],
      })),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

/** GET /api/validate — issues only, with a derived ok flag. */
export async function getValidate(c: Context, index: GraphIndex): Promise<Response> {
  try {
    const issues = index.issues();
    return c.json({ ok: issues.length === 0, issues, revision: index.revision });
  } catch (error) {
    return errorResponse(c, error);
  }
}

/** GET /api/nodes/:id — one full node (body on demand) with its issues and the revision for If-Match-style saves. */
export async function getNode(c: Context, index: GraphIndex): Promise<Response> {
  try {
    const id = requireParam(c);
    const entry = index.entry(id);
    if (entry === undefined) {
      throw new RefinoError("NODE_NOT_FOUND", `Node "${id}" does not exist.`);
    }
    const body = (await index.readBody(id)) ?? "";
    return c.json({
      revision: entry.revision,
      node: nodeJson({ ...entry.node, body }),
      issues: index.issuesFor(id),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

/** A parsed JSON request body; field shapes are validated on access. */
export type Payload = Record<string, unknown>;

/** POST /api/nodes/premise — create a premise from a JSON payload. */
export async function postPremise(c: Context, index: GraphIndex): Promise<Response> {
  return create(c, index, "premise");
}

/** POST /api/nodes/constraint — create a constraint from a JSON payload. */
export async function postConstraint(c: Context, index: GraphIndex): Promise<Response> {
  return create(c, index, "constraint");
}

async function create(
  c: Context,
  index: GraphIndex,
  type: "premise" | "constraint",
): Promise<Response> {
  try {
    const payload = await readPayload(c);
    const body = readRequiredString(payload, "body");
    const summary = readString(payload, "summary");
    // A brand-new id has no dependents, so only reference existence can be
    // violated; cycles and premise grounds are impossible by construction.
    const grounds = resolveGrounds(payload);
    if (type === "constraint") {
      const missing = grounds.find((g) => !index.graph.nodes.has(g));
      if (missing !== undefined) {
        throw new RefinoError("UNKNOWN_GROUND", `Ground "${missing}" does not exist.`);
      }
    }
    const id =
      type === "premise"
        ? await createPremise(index.refinoDir, {
            body,
            summary,
            confirmed: readString(payload, "confirmed"),
          })
        : await createConstraint(index.refinoDir, {
            body,
            summary,
            rationale: readString(payload, "rationale"),
            grounds,
          });
    await index.applyChange({ changed: [id] });
    return c.json({ id, revision: index.entry(id)?.revision }, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
}

/**
 * PUT /api/nodes/:id — replace the editable fields of an existing node.
 * Sending a `type` different from the node's current type converts the node
 * in place: same id, new file; fields of the old type that do not exist on
 * the new one are dropped. A payload `revision` (recorded when the client
 * opened the node) turns the save into an optimistic concurrency check:
 * a mismatch answers 409 instead of silently overwriting the external change.
 */
export async function putNode(c: Context, index: GraphIndex): Promise<Response> {
  try {
    const id = requireParam(c);
    const entry = index.entry(id);
    if (entry === undefined) {
      throw new RefinoError("NODE_NOT_FOUND", `Node "${id}" does not exist.`);
    }
    const payload = await readPayload(c);
    const body = readRequiredString(payload, "body");
    const summary = readString(payload, "summary");
    const clientRevision = readRevision(payload);
    if (clientRevision !== undefined && clientRevision !== entry.revision) {
      return c.json(
        {
          error: `Node "${id}" changed externally since it was opened; reload before saving.`,
          revision: entry.revision,
        },
        409,
      );
    }
    const targetType = readTargetType(payload, entry.node.type);

    if (targetType === entry.node.type) {
      if (targetType === "premise") {
        await updatePremise(index.refinoDir, id, {
          body,
          summary,
          confirmed: readString(payload, "confirmed") ?? entry.node.confirmed,
        });
      } else {
        const grounds = resolveGrounds(payload);
        const issues = checkGroundsChange(index.graph, id, grounds);
        if (issues.length > 0) {
          return c.json({ error: "Invalid grounds change.", issues }, 400);
        }
        await updateConstraint(index.refinoDir, id, {
          body,
          summary,
          rationale: readString(payload, "rationale") ?? entry.node.rationale,
          grounds,
        });
      }
      await index.applyChange({ changed: [id] });
      return c.json({ id, revision: index.entry(id)?.revision });
    }

    // Type conversion. grounds on a converted premise are rejected; for the
    // constraint direction a new cycle must run ground -> ... -> id along
    // existing grounds edges (the engine primitive cannot be used: it
    // assumes the target keeps its type).
    const grounds = resolveGrounds(payload);
    if (targetType === "premise") {
      if (grounds.length > 0) {
        throw new RefinoError(
          "PREMISE_WITH_GROUNDS",
          `Premise "${id}" must not declare "grounds".`,
        );
      }
    } else {
      const missing = grounds.find((g) => !index.graph.nodes.has(g));
      if (missing !== undefined) {
        throw new RefinoError("UNKNOWN_GROUND", `Ground "${missing}" does not exist.`);
      }
      for (const ground of grounds) {
        if (getAncestors(index.graph, ground).some((a) => a.node.id === id)) {
          throw new RefinoError("CYCLE", `Grounding "${id}" by "${ground}" would close a cycle.`);
        }
      }
    }
    await deleteNode(index.refinoDir, id);
    if (targetType === "premise") {
      await createPremise(index.refinoDir, {
        id,
        body,
        summary,
        confirmed: readString(payload, "confirmed") ?? entry.node.confirmed,
      });
    } else {
      await createConstraint(index.refinoDir, {
        id,
        body,
        summary,
        rationale: readString(payload, "rationale") ?? entry.node.rationale,
        grounds,
      });
    }
    await index.applyChange({ changed: [id] });
    return c.json({ id, revision: index.entry(id)?.revision });
  } catch (error) {
    return errorResponse(c, error);
  }
}

/** DELETE /api/nodes/:id — refuse while transitive dependents reference the node. */
export async function removeNode(c: Context, index: GraphIndex): Promise<Response> {
  try {
    const id = requireParam(c);
    if (index.entry(id) === undefined) {
      throw new RefinoError("NODE_NOT_FOUND", `Node "${id}" does not exist.`);
    }
    const affected = getDependents(index.graph, id);
    if (affected.length > 0) {
      return c.json(
        {
          error: `Node "${id}" is still referenced by ${affected.length} downstream constraint(s).`,
          dependents: affected.map((entry) => ({ id: entry.node.id, depth: entry.depth })),
        },
        409,
      );
    }
    await deleteNode(index.refinoDir, id);
    await index.applyChange({ deleted: [id] });
    return c.json({ id });
  } catch (error) {
    return errorResponse(c, error);
  }
}

/** POST /api/reload — full rescan and index rebuild; the authoritative recovery channel. */
export async function postReload(c: Context, index: GraphIndex): Promise<Response> {
  try {
    return c.json(await index.reload());
  } catch (error) {
    return errorResponse(c, error);
  }
}

/** Validate an optional `type` override in the payload. */
function readTargetType(payload: Payload, current: "premise" | "constraint") {
  const raw = readString(payload, "type");
  if (raw === undefined) return current;
  if (raw !== "premise" && raw !== "constraint") {
    throw new RefinoError("INVALID_FRONTMATTER", `"type" must be "premise" or "constraint".`);
  }
  return raw;
}

/** Parse `grounds` from a payload: shape-checked, deduplicated; omitted means full replacement with none. */
function resolveGrounds(payload: Payload): string[] {
  if (payload.grounds === undefined) return [];
  if (
    !Array.isArray(payload.grounds) ||
    payload.grounds.some((g) => typeof g !== "string" || !ID_RE.test(g))
  ) {
    throw new RefinoError("INVALID_GROUNDS", "grounds must be an array of node ids.");
  }
  return [...new Set(payload.grounds as string[])];
}

export async function readPayload(c: Context): Promise<Payload> {
  const payload: unknown = await c.req.json().catch(() => {
    throw new RefinoError("INVALID_FRONTMATTER", "Request body must be valid JSON.");
  });
  if (typeof payload !== "object" || payload === null) {
    throw new RefinoError("INVALID_FRONTMATTER", "Request body must be a JSON object.");
  }
  return payload as Payload;
}

function requireParam(c: Context): string {
  const id = c.req.param("id");
  if (id === undefined) {
    throw new RefinoError("NODE_NOT_FOUND", "Node id is required.");
  }
  return id;
}

function readRequiredString(payload: Payload, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") {
    throw new RefinoError("INVALID_FRONTMATTER", `"${key}" is required and must be a string.`);
  }
  return value;
}

export function readString(payload: Payload, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new RefinoError("INVALID_FRONTMATTER", `"${key}" must be a string.`);
  }
  return value;
}

/** The client's known node revision for the optimistic concurrency check. */
function readRevision(payload: Payload): number | undefined {
  const value = payload.revision;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RefinoError("INVALID_FRONTMATTER", `"revision" must be a non-negative integer.`);
  }
  return value;
}

export function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Map errors to HTTP responses; RefinoIssue-bearing errors carry their issues. */
export function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof RefinoError) {
    return c.json({ error: error.message }, errorStatus(error.code));
  }
  throw error;
}

function errorStatus(code: RefinoError["code"]): 400 | 404 {
  if (code === "NODE_NOT_FOUND" || code === "REFINO_DIR_NOT_FOUND") return 404;
  return 400;
}
