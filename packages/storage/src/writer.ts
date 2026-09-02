import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateId, ID_RE, RefinoError, serializeNode } from "refino";

/**
 * Node creation. This is the storage adapter's write path; everything else
 * stays read-only. Node ids are unique across the whole `.refino` directory:
 * explicitly given ids must match `ID_RE` and not collide with any existing
 * node file in either storage directory; generated ids guarantee the same.
 */

const STORAGE_DIRS = ["premises", "constraints"] as const;

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
  const existingIds = await readAllExistingIds(refinoDir);
  let id: string;
  if (explicitId !== undefined) {
    if (!ID_RE.test(explicitId)) {
      throw new RefinoError(
        "INVALID_ID",
        `Node id must be an 8-character Crockford base32 id (0-9, A-Z minus I, L, O, U), got "${explicitId}".`,
      );
    }
    if (existingIds.has(explicitId)) {
      throw new RefinoError("DUPLICATE_ID", `Node id "${explicitId}" is already in use.`);
    }
    id = explicitId;
  } else {
    do {
      id = generateId();
    } while (existingIds.has(id));
  }
  const dir = join(refinoDir, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.md`), serializeNode(fields, body), "utf8");
  return id;
}

/** All ids of existing node files across both storage directories. */
async function readAllExistingIds(refinoDir: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const dirName of STORAGE_DIRS) {
    let entries: string[];
    try {
      entries = await readdir(join(refinoDir, dirName));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // subdir optional
      throw error;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const id = entry.slice(0, -".md".length);
      if (ID_RE.test(id)) ids.add(id);
    }
  }
  return ids;
}
