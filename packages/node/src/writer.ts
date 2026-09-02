import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateId, ID_RE, serializeNode } from "refino";

/**
 * Node creation. This is the storage adapter's write path; everything else
 * stays read-only. Ids are generated internally and guaranteed not to
 * collide with existing node files in the target directory.
 */

export interface CreateOptions {
  body: string;
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
  return createNode(refinoDir, "premises", fields, opts.body);
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
  return createNode(refinoDir, "constraints", fields, opts.body);
}

async function createNode(
  refinoDir: string,
  dirName: "premises" | "constraints",
  fields: Record<string, unknown>,
  body: string,
): Promise<string> {
  const dir = join(refinoDir, dirName);
  await mkdir(dir, { recursive: true });
  const existingIds = await readExistingIds(dir);
  let id: string;
  do {
    id = generateId();
  } while (existingIds.has(id));
  await writeFile(join(dir, `${id}.md`), serializeNode(fields, body), "utf8");
  return id;
}

async function readExistingIds(dir: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const entry of await readdir(dir)) {
    if (!entry.endsWith(".md")) continue;
    const id = entry.slice(0, -".md".length);
    if (ID_RE.test(id)) ids.add(id);
  }
  return ids;
}
