import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generateId, ID_RE, IssueCode, RefinoError } from "refino";
import type { NodeType } from "refino";
import { serializeNode } from "./serialize.js";

const NODES_DIR = "nodes";

export const NODE_TYPES: ReadonlyArray<NodeType> = ["premise", "constraint"];

/**
 * Node creation. This is the storage adapter's write path; everything else
 * stays read-only. Node ids are globally unique and map to exactly two
 * candidate file paths (path is identity): `nodes/<first 2 id
 * chars>/<rest>-premise.md` and `...-constraint.md`. Uniqueness is therefore
 * checked against those two paths only, never by scanning.
 */

export interface CreateOptions {
  body: string;
  /**
   * Explicit node id, valid per the engine's id rule (3-16 characters of
   * A-Z, 0-9, _); generated when omitted.
   */
  id?: string;
  /**
   * Independent summary attribute; stored as a "summary" frontmatter field.
   * When omitted, readers fall back to the first paragraph of the body.
   */
  summary?: string;
}

export interface CreatePremiseOptions extends CreateOptions {
  /** RFC 3339 timestamp with an explicit UTC offset. */
  confirmed?: string;
}

export interface CreateConstraintOptions extends CreateOptions {
  /** Ids of upstream premise/constraint nodes. */
  grounds?: string[];
  /** Why the decision was made. */
  rationale?: string;
}

/** Create a premise node file under `<refinoDir>/nodes/`; returns the new id. */
export async function createPremise(
  refinoDir: string,
  opts: CreatePremiseOptions,
): Promise<string> {
  const fields: Record<string, unknown> = { confirmed: opts.confirmed, summary: opts.summary };
  return createNode(refinoDir, "premise", fields, opts.body, opts.id);
}

/** Create a constraint node file under `<refinoDir>/nodes/`; returns the new id. */
export async function createConstraint(
  refinoDir: string,
  opts: CreateConstraintOptions,
): Promise<string> {
  const fields: Record<string, unknown> = {
    grounds: opts.grounds,
    rationale: opts.rationale,
    summary: opts.summary,
  };
  return createNode(refinoDir, "constraint", fields, opts.body, opts.id);
}

async function createNode(
  refinoDir: string,
  type: NodeType,
  fields: Record<string, unknown>,
  body: string,
  explicitId?: string,
): Promise<string> {
  let id: string;
  if (explicitId !== undefined) {
    if (!ID_RE.test(explicitId)) {
      throw new RefinoError(
        IssueCode.InvalidId,
        `Node id must be 3-16 characters of A-Z, 0-9 or _, got "${explicitId}".`,
      );
    }
    if (await idExists(refinoDir, explicitId)) {
      throw new RefinoError(IssueCode.DuplicateId, `Node id "${explicitId}" is already in use.`);
    }
    id = explicitId;
  } else {
    do {
      id = generateId();
    } while (await idExists(refinoDir, id));
  }
  const file = nodeFilePath(refinoDir, type, id);
  await mkdir(dirname(file), { recursive: true });
  await atomicWriteFile(file, serializeNode(fields, body));
  return id;
}

/**
 * Canonical `.refino`-relative path of a node, always forward-slash:
 * `nodes/<first 2 id chars>/<rest>-<type>.md`. The `-` separator is
 * unambiguous because ids never contain `-` (engine id rule).
 */
export function nodeRelativeFile(type: NodeType, id: string): string {
  return `${NODES_DIR}/${id.slice(0, 2)}/${id.slice(2)}-${type}.md`;
}

/** Absolute path of a node file of the given type (platform separators). */
export function nodeFilePath(refinoDir: string, type: NodeType, id: string): string {
  return join(refinoDir, nodeRelativeFile(type, id));
}

/**
 * Node update. Update semantics are PUT-like: the given fields fully replace
 * the node's editable content (body and frontmatter fields); type and id are
 * fixed by the existing file and cannot be changed. Omitted optional fields
 * are removed from the file. Grounds reference validity is not checked here —
 * it is a graph-level concern reported by the engine's validation.
 */

export interface UpdateOptions {
  body: string;
  /**
   * Independent summary attribute; stored as a "summary" frontmatter field.
   * When omitted, readers fall back to the first paragraph of the body.
   */
  summary?: string;
}

export interface UpdatePremiseOptions extends UpdateOptions {
  /** RFC 3339 timestamp with an explicit UTC offset. */
  confirmed?: string;
}

export interface UpdateConstraintOptions extends UpdateOptions {
  /** Ids of upstream premise/constraint nodes. */
  grounds?: string[];
  /** Why the decision was made. */
  rationale?: string;
}

/** Overwrite an existing premise node file; throws NODE_NOT_FOUND if absent. */
export async function updatePremise(
  refinoDir: string,
  id: string,
  opts: UpdatePremiseOptions,
): Promise<void> {
  const fields: Record<string, unknown> = { confirmed: opts.confirmed, summary: opts.summary };
  await updateNode(refinoDir, "premise", id, fields, opts.body);
}

/** Overwrite an existing constraint node file; throws NODE_NOT_FOUND if absent. */
export async function updateConstraint(
  refinoDir: string,
  id: string,
  opts: UpdateConstraintOptions,
): Promise<void> {
  const fields: Record<string, unknown> = {
    grounds: opts.grounds,
    rationale: opts.rationale,
    summary: opts.summary,
  };
  await updateNode(refinoDir, "constraint", id, fields, opts.body);
}

async function updateNode(
  refinoDir: string,
  type: NodeType,
  id: string,
  fields: Record<string, unknown>,
  body: string,
): Promise<void> {
  assertValidId(id);
  const file = nodeFilePath(refinoDir, type, id);
  if (!(await fileExists(file))) {
    throw new RefinoError(IssueCode.NodeNotFound, `Node "${id}" does not exist.`);
  }
  await atomicWriteFile(file, serializeNode(fields, body));
}

/**
 * Delete a node file. Ids are globally unique across both candidate paths, so
 * deleting removes whichever type-specific file exists; throws NODE_NOT_FOUND
 * when neither does. Referencing nodes are left untouched — dangling grounds
 * surface as UNKNOWN_GROUND issues on the next load.
 */
export async function deleteNode(refinoDir: string, id: string): Promise<void> {
  assertValidId(id);
  for (const type of NODE_TYPES) {
    const file = nodeFilePath(refinoDir, type, id);
    if (await fileExists(file)) {
      await unlink(file);
      return;
    }
  }
  throw new RefinoError(IssueCode.NodeNotFound, `Node "${id}" does not exist.`);
}

function assertValidId(id: string): void {
  if (!ID_RE.test(id)) {
    throw new RefinoError(
      IssueCode.InvalidId,
      `Node id must be 3-16 characters of A-Z, 0-9 or _, got "${id}".`,
    );
  }
}

/**
 * Monotonic suffix making temp names unique within the process; the pid
 * disambiguates across processes.
 */
let tempSeq = 0;

/**
 * Sole filesystem write primitive: write to a temp file in the target's
 * directory, then rename it into place, so readers (loader scans, directory
 * watchers) never observe a half-written node file. The temp name never
 * matches the `<id_2>-<type>.md` node shape, so the loader silently skips it.
 * Not part of the package's public API; exported for tests.
 */
export async function atomicWriteFile(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}-${tempSeq++}.tmp`;
  try {
    await writeFile(tmp, content, "utf8");
    // A concurrent reader holding the destination open can transiently fail
    // the replace on Windows; back off briefly before giving up.
    for (let attempt = 1; ; attempt++) {
      try {
        await rename(tmp, file);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 3 || (code !== "EPERM" && code !== "EACCES")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
      }
    }
  } catch (error) {
    await unlink(tmp).catch(() => {}); // best-effort temp cleanup
    throw error;
  }
}

/** Whether either candidate path of the id exists (ids are globally unique). */
async function idExists(refinoDir: string, id: string): Promise<boolean> {
  for (const type of NODE_TYPES) {
    if (await fileExists(nodeFilePath(refinoDir, type, id))) return true;
  }
  return false;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
