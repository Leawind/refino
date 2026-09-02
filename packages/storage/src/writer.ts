import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generateId, ID_RE, RefinoError } from "refino";
import { readAllExistingIds } from "./loader.js";
import { serializeNode } from "./serialize.js";

/**
 * Node creation. This is the storage adapter's write path; everything else
 * stays read-only. Node ids are unique across the whole `.refino` directory
 * and map to exactly one file path (path is identity):
 * `<type>/<first 2 id chars>/<last 6 id chars>.md`.
 */

export interface CreateOptions {
  body: string;
  /** Explicit node id (8-character Crockford base32); generated when omitted. */
  id?: string;
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

/** Create a premise node file under `<refinoDir>/premises/`; returns the new id. */
export async function createPremise(
  refinoDir: string,
  opts: CreatePremiseOptions,
): Promise<string> {
  const fields: Record<string, unknown> = { confirmed: opts.confirmed };
  return createNode(refinoDir, "premises", fields, opts.body, opts.id);
}

/** Create a constraint node file under `<refinoDir>/constraints/`; returns the new id. */
export async function createConstraint(
  refinoDir: string,
  opts: CreateConstraintOptions,
): Promise<string> {
  const fields: Record<string, unknown> = {
    grounds: opts.grounds,
    rationale: opts.rationale,
  };
  return createNode(refinoDir, "constraints", fields, opts.body, opts.id);
}

async function createNode(
  refinoDir: string,
  dirName: "premises" | "constraints",
  fields: Record<string, unknown>,
  body: string,
  explicitId?: string,
): Promise<string> {
  let id: string;
  if (explicitId !== undefined) {
    if (!ID_RE.test(explicitId)) {
      throw new RefinoError(
        "INVALID_ID",
        `Node id must be an 8-character Crockford base32 id (0-9, A-Z minus I, L, O, U), got "${explicitId}".`,
      );
    }
    // Node ids are globally unique; checking the whole store (not just the
    // unique derived path) keeps cross-directory duplicates out on write.
    const existingIds = await readAllExistingIds(refinoDir);
    if (existingIds.has(explicitId)) {
      throw new RefinoError("DUPLICATE_ID", `Node id "${explicitId}" is already in use.`);
    }
    id = explicitId;
  } else {
    // Generated ids must avoid every existing node file in both trees.
    const existingIds = await readAllExistingIds(refinoDir);
    do {
      id = generateId();
    } while (existingIds.has(id));
  }
  const file = nodeFilePath(refinoDir, dirName, id);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, serializeNode(fields, body), "utf8");
  return id;
}

/** Canonical `.refino`-relative path of a node: `<type>/<2 chars>/<6 chars>.md`. */
function nodeFilePath(
  refinoDir: string,
  dirName: "premises" | "constraints",
  id: string,
): string {
  return join(refinoDir, dirName, id.slice(0, 2), `${id.slice(2)}.md`);
}
