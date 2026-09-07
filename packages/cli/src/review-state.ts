import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Graph } from "refino";
import type { CliIo } from "./format.js";

/**
 * The review ledger (docs/design.md, "通用接入形态" — 审核状态的作用域): the
 * workspace state lane of the generic skill+CLI form. Write commands record
 * the affected downstream of each change (the store's `StoreChange.affected`,
 * the pending-review raw material of docs/crg.md 1.6) here, so review
 * obligations survive the commit that eventually lands the change; a human
 * resolves them with `refino review ack`. The ledger is progress tracking,
 * not a permission: nothing reads it to guard a read or write. Entries
 * converge against the live graph on every read — ids whose nodes are gone
 * are silently dropped.
 */

export interface ReviewEntry {
  /** The node awaiting review (an affected downstream of the source change). */
  id: string;
  /** The node whose change pulled `id` into review. */
  source: string;
  kind: "update" | "delete";
  /** RFC 3339 timestamp of the earliest still-unresolved recording. */
  addedAt: string;
}

export interface ReviewLedger {
  version: 1;
  pending: ReviewEntry[];
}

/**
 * The ledger file: `<root>/.refino/state/review.json`, inside the adopted
 * repository's own `.refino/` and kept out of version control by the
 * committed `.refino/.gitignore`. Workspace-scoped on purpose: worktrees are
 * isolated by the filesystem and there is no user-level directory to key.
 */
export function reviewStatePath(root: string): string {
  return join(root, ".refino", "state", "review.json");
}

/**
 * Read the ledger, converged against the current graph when given: entries
 * whose node no longer exists are dropped (the obligation died with the
 * node). A missing file is an empty ledger; a malformed one is an error the
 * caller surfaces — silent loss of review state is worse than a hard stop.
 */
export async function readLedger(root: string, graph?: Graph): Promise<ReviewLedger> {
  const path = reviewStatePath(root);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, pending: [] };
    throw new Error(
      `cannot read the review ledger at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`the review ledger at ${path} is not valid JSON; delete the file to reset it`, {
      cause: error,
    });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { pending?: unknown }).pending)
  ) {
    throw new Error(`the review ledger at ${path} is malformed; delete the file to reset it`);
  }
  const rawEntries = (parsed as { pending: unknown[] }).pending;
  const byId = new Map<string, ReviewEntry>();
  for (const item of rawEntries) {
    const entry = parseEntry(item);
    if (entry !== undefined && (graph === undefined || graph.nodes.has(entry.id))) {
      byId.set(entry.id, entry);
    }
  }
  return { version: 1, pending: sortEntries([...byId.values()]) };
}

/**
 * Merge freshly affected ids into the ledger. Per-id single entry: a re-entry
 * refreshes the cause (source/kind) but keeps the earliest addedAt, so the
 * queue orders by how long an item has been waiting, not by the latest touch.
 */
export async function recordAffected(
  root: string,
  affected: ReadonlyArray<{ id: string; source: string; kind: ReviewEntry["kind"] }>,
): Promise<ReviewEntry[]> {
  const ledger = await readLedger(root);
  const byId = new Map(ledger.pending.map((entry) => [entry.id, entry]));
  const now = new Date().toISOString();
  for (const item of affected) {
    const existing = byId.get(item.id);
    byId.set(item.id, {
      id: item.id,
      source: item.source,
      kind: item.kind,
      addedAt: existing?.addedAt ?? now,
    });
  }
  const pending = sortEntries([...byId.values()]);
  await writeLedger(root, { version: 1, pending });
  return pending;
}

/** Remove acknowledged ids. Returns the ids that were not in the ledger. */
export async function ackEntries(root: string, ids: readonly string[]): Promise<string[]> {
  const ledger = await readLedger(root);
  const removed = new Set(ids);
  const kept = ledger.pending.filter((entry) => !removed.has(entry.id));
  const missing = [...removed].filter((id) => !ledger.pending.some((entry) => entry.id === id));
  if (missing.length === 0 || kept.length < ledger.pending.length) {
    await writeLedger(root, { version: 1, pending: kept });
  }
  return missing;
}

/** Atomic write (temp file + rename), mirroring the storage layer's discipline. */
async function writeLedger(root: string, ledger: ReviewLedger): Promise<void> {
  const path = reviewStatePath(root);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

function sortEntries(entries: ReviewEntry[]): ReviewEntry[] {
  return entries.sort((a, b) =>
    a.addedAt !== b.addedAt ? (a.addedAt < b.addedAt ? -1 : 1) : a.id < b.id ? -1 : 1,
  );
}

function parseEntry(item: unknown): ReviewEntry | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const { id, source, kind, addedAt } = item as Record<string, unknown>;
  if (typeof id !== "string" || typeof source !== "string" || typeof addedAt !== "string") {
    return undefined;
  }
  if (kind !== "update" && kind !== "delete") return undefined;
  return { id, source, kind, addedAt };
}

/**
 * Record a write command's affected downstream, best-effort: the graph write
 * has already succeeded, so a ledger failure degrades to a warning instead of
 * failing the command. Returns the recorded ids for the command's output.
 */
export async function recordWriteOutcome(
  io: CliIo,
  root: string,
  source: string,
  kind: ReviewEntry["kind"],
  affected: string[] | undefined,
): Promise<string[]> {
  if (affected === undefined || affected.length === 0) return [];
  try {
    await recordAffected(
      root,
      affected.map((id) => ({ id, source, kind })),
    );
  } catch (error) {
    io.stderr.write(
      `warning: could not record the review ledger: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  return affected;
}
