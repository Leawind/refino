import {
  confirmedToMs,
  createConstraint,
  createPremise,
  deleteNode,
  isValidConfirmed,
  updateConstraint,
  updatePremise,
  StorageIssueCode,
  type NodeContent,
} from "@refino/storage";
import { checkGroundsChange, getDependents, ID_RE, IssueCode, RefinoError } from "refino";
import type { Context } from "hono";
import type { GraphIndex } from "./graph-index.js";

/**
 * Read/write JSON API over the resident graph index. All endpoints return
 * JSON; errors are `{ error: string, issues?: RefinoIssue[] }` with a mapped
 * status code. Handlers assume the index is ready (the server awaits
 * `index.ready()` before dispatching).
 *
 * Grounds reference validity and cycles are checked before writing so the
 * stored files never become invalid through the API. Updates validate
 * through the engine's `checkGroundsChange` primitive (docs/design.md,
 * "引擎提供的共享原语"); creation of a brand-new node has no dependents, so
 * only reference existence can be violated and is checked against the index.
 */

/** The node record as exposed over the API. */
export function nodeJson(
  node: { id: string; type: string; summary: string } & Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: node.id,
    type: node.type,
    summary: node.summary,
    body: node.body,
    ...(node.type === "constraint" && { grounds: node.grounds ?? [] }),
    ...(node.type === "constraint" &&
      node.rationale !== undefined && { rationale: node.rationale }),
    ...(node.type === "premise" && node.confirmed !== undefined && { confirmed: node.confirmed }),
  };
}

/**
 * Wire code for request-shape errors raised by the web layer itself (bad
 * JSON, wrong field types). The web layer defines its own code instead of
 * borrowing one from the engine or the storage format.
 */
export const INVALID_REQUEST = "INVALID_REQUEST";

/** GET /api/graph — all nodes, validation issues and per-node dependents (compatibility endpoint; the canvas uses /api/query/*). */
export async function getGraph(c: Context, index: GraphIndex): Promise<Response> {
  try {
    const graph = index.graph;
    const nodes = [...graph.nodes.values()].sort(byId);
    const contents = await Promise.all(nodes.map((node) => index.readContent(node.id)));
    return c.json({
      revision: index.revision,
      issues: index.issues(),
      nodes: nodes.map((node, i) => ({
        ...nodeJson({ ...node, ...contents[i] }),
        dependents: node.children,
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

/** GET /api/nodes/:id — one full node (content on demand) with its issues and the revision for If-Match-style saves. */
export async function getNode(c: Context, index: GraphIndex): Promise<Response> {
  try {
    const id = requireParam(c);
    const entry = index.entry(id);
    if (entry === undefined) {
      throw new RefinoError(IssueCode.NodeNotFound, `Node "${id}" does not exist.`);
    }
    const content: NodeContent = (await index.readContent(id)) ?? { body: "" };
    return c.json({
      revision: entry.revision,
      node: nodeJson({ ...entry.node, ...content }),
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
    // violated; cycles are impossible by construction. Grounds sent for a
    // premise are a misplaced attribute and silently ignored.
    const grounds = resolveGrounds(payload);
    if (type === "constraint") {
      const missing = grounds.find((g) => !index.graph.nodes.has(g));
      if (missing !== undefined) {
        throw new RefinoError(IssueCode.UnknownGround, `Ground "${missing}" does not exist.`);
      }
    }
    const id =
      type === "premise"
        ? await createPremise(index.refinoDir, {
            body,
            summary,
            confirmed: readConfirmed(payload),
          })
        : await createConstraint(index.refinoDir, {
            body,
            summary,
            rationale: readString(payload, "rationale"),
            grounds,
          });
    await index.applyChange({ changed: [id], origin: "api" });
    return c.json({ id, revision: index.entry(id)?.revision }, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
}

/**
 * PUT /api/nodes/:id — replace the editable fields of an existing node.
 * Replacement is wholesale, mirroring the storage writer: an optional field
 * absent from the payload is removed from the node (an empty string in the
 * editor serializes as absent, so clearing a field clears the node).
 * The node's id and type are fixed by its existing file: a payload `type`
 * that differs from the current type is rejected (types cannot change).
 * A payload `revision` (recorded when the client opened the node) turns the
 * save into an optimistic concurrency check: a mismatch answers 409 instead
 * of silently overwriting the external change.
 *
 * PUT to an id that does not exist creates it when the payload states a
 * `type` (docs/design.md, "编辑冲突处理": 以我的内容重新创建该 id) — the
 * detail editor recreates a node that external tools deleted while it held
 * unsaved edits.
 */
export async function putNode(c: Context, index: GraphIndex): Promise<Response> {
  try {
    const id = requireParam(c);
    const entry = index.entry(id);
    if (entry === undefined) {
      // await: without it a rejection escapes the try/catch below.
      return await createWithId(c, index, id);
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
    const typeField = readString(payload, "type");
    if (typeField !== undefined && typeField !== entry.node.type) {
      throw new RefinoError(
        INVALID_REQUEST,
        `"type" does not match the existing node "${id}"; node types cannot change.`,
      );
    }

    if (entry.node.type === "premise") {
      await updatePremise(index.refinoDir, id, {
        body,
        summary,
        confirmed: readConfirmed(payload),
      });
    } else {
      const grounds = resolveGrounds(payload);
      const issues = checkGroundsChange(index.graph, entry.node, grounds);
      if (issues.length > 0) {
        return c.json({ error: "Invalid grounds change.", issues }, 400);
      }
      await updateConstraint(index.refinoDir, id, {
        body,
        summary,
        rationale: readString(payload, "rationale"),
        grounds,
      });
    }
    await index.applyChange({ changed: [id], origin: "api" });
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
      throw new RefinoError(IssueCode.NodeNotFound, `Node "${id}" does not exist.`);
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
    await index.applyChange({ deleted: [id], origin: "api" });
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

/**
 * Create a node under the given (still free) id from a PUT payload. The
 * type must be stated explicitly; grounds rules match the create endpoint.
 */
async function createWithId(c: Context, index: GraphIndex, id: string): Promise<Response> {
  if (!ID_RE.test(id)) {
    throw new RefinoError(IssueCode.InvalidId, `Node "${id}" is not a valid node id.`);
  }
  const payload = await readPayload(c);
  const body = readRequiredString(payload, "body");
  const summary = readString(payload, "summary");
  const type = readString(payload, "type");
  if (type !== "premise" && type !== "constraint") {
    throw new RefinoError(
      INVALID_REQUEST,
      `"type" must be "premise" or "constraint" to create node "${id}".`,
    );
  }
  const grounds = resolveGrounds(payload);
  if (type === "constraint") {
    const missing = grounds.find((g) => !index.graph.nodes.has(g));
    if (missing !== undefined) {
      throw new RefinoError(IssueCode.UnknownGround, `Ground "${missing}" does not exist.`);
    }
  }
  if (type === "premise") {
    await createPremise(index.refinoDir, {
      id,
      body,
      summary,
      confirmed: readConfirmed(payload),
    });
  } else {
    await createConstraint(index.refinoDir, {
      id,
      body,
      summary,
      rationale: readString(payload, "rationale"),
      grounds,
    });
  }
  await index.applyChange({ changed: [id], origin: "api" });
  return c.json({ id, revision: index.entry(id)?.revision }, 201);
}

/** Parse `grounds` from a payload: shape-checked, deduplicated; omitted means full replacement with none. */
function resolveGrounds(payload: Payload): string[] {
  if (payload.grounds === undefined) return [];
  if (
    !Array.isArray(payload.grounds) ||
    payload.grounds.some((g) => typeof g !== "string" || !ID_RE.test(g))
  ) {
    throw new RefinoError(IssueCode.InvalidGrounds, "grounds must be an array of node ids.");
  }
  return [...new Set(payload.grounds as string[])];
}

export async function readPayload(c: Context): Promise<Payload> {
  const payload: unknown = await c.req.json().catch(() => {
    throw new RefinoError(INVALID_REQUEST, "Request body must be valid JSON.");
  });
  if (typeof payload !== "object" || payload === null) {
    throw new RefinoError(INVALID_REQUEST, "Request body must be a JSON object.");
  }
  return payload as Payload;
}

function requireParam(c: Context): string {
  const id = c.req.param("id");
  if (id === undefined) {
    throw new RefinoError(IssueCode.NodeNotFound, "Node id is required.");
  }
  return id;
}

function readRequiredString(payload: Payload, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") {
    throw new RefinoError(INVALID_REQUEST, `"${key}" is required and must be a string.`);
  }
  return value;
}

/**
 * The payload's `confirmed` timestamp as epoch milliseconds, format-checked
 * at this boundary: the web write paths must not store a value that only
 * surfaces later as an INVALID_CONFIRMED issue on load.
 */
function readConfirmed(payload: Payload): number | undefined {
  const confirmed = readString(payload, "confirmed");
  if (confirmed !== undefined && !isValidConfirmed(confirmed)) {
    throw new RefinoError(
      StorageIssueCode.InvalidConfirmed,
      `"confirmed" must be an RFC 3339 timestamp with an explicit UTC offset (Z or ±HH:MM), got "${confirmed}".`,
    );
  }
  return confirmed === undefined ? undefined : confirmedToMs(confirmed);
}

export function readString(payload: Payload, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new RefinoError(INVALID_REQUEST, `"${key}" must be a string.`);
  }
  return value;
}

/** The client's known node revision for the optimistic concurrency check. */
function readRevision(payload: Payload): number | undefined {
  const value = payload.revision;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RefinoError(INVALID_REQUEST, `"revision" must be a non-negative integer.`);
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
  if (code === IssueCode.NodeNotFound || code === StorageIssueCode.RefinoDirNotFound) return 404;
  return 400;
}
