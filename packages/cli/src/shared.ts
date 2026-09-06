import { join } from "node:path";
import { RefinoStore, StorageIssueCode, WriteRejected } from "@refino/storage";
import type { StorageIssue } from "@refino/storage";
import type { Command } from "commander";
import { RefinoError } from "refino";
import type { RefinoIssue } from "refino";
import { renderIssues } from "./format.js";
import type { CliIo } from "./format.js";

export interface GlobalOptions {
  root: string;
  json: boolean;
  /** Explicit orchestrator authorization document; overrides workspace state. */
  authorization?: string;
}

/** Run an action with merged global options and capture its exit code. */
export type RunFn = (
  cmd: Command,
  action: (opts: GlobalOptions) => Promise<number>,
) => Promise<void>;

export function refinoDir(opts: GlobalOptions): string {
  return join(opts.root, ".refino");
}

/**
 * Open the store and run a query against it. Graph issues make query results
 * ambiguous, so queries refuse to run while any exist.
 */
export async function withStore(
  io: CliIo,
  opts: GlobalOptions,
  query: (store: RefinoStore) => number | Promise<number>,
): Promise<number> {
  const store = RefinoStore.open(refinoDir(opts));
  try {
    await store.ready();
    const issues = store.issues();
    if (issues.length > 0) return reportBlockingIssues(io, opts, issues);
    return await query(store);
  } catch (error) {
    return fail(io, error);
  } finally {
    store.close();
  }
}

/**
 * Open the store for a write command. Pre-existing issues elsewhere must not
 * block the write; the store's write methods validate the change itself and
 * reject it with the offending issues before anything is written.
 */
export async function withStoreForWrite(
  io: CliIo,
  opts: GlobalOptions,
  action: (store: RefinoStore) => Promise<number>,
): Promise<number> {
  const store = RefinoStore.open(refinoDir(opts));
  try {
    try {
      await store.ready();
    } catch (error) {
      // A missing `.refino` directory is the empty store, not an error:
      // creating the first node must work.
      if (!(error instanceof RefinoError) || error.code !== StorageIssueCode.RefinoDirNotFound) {
        throw error;
      }
    }
    return await action(store);
  } catch (error) {
    if (error instanceof WriteRejected) {
      io.stderr.write(`${renderIssues(error.issues)}\n`);
      return 1;
    }
    return fail(io, error);
  } finally {
    store.close();
  }
}

/** Graph issues make query results ambiguous, so queries refuse to run. */
function reportBlockingIssues(
  io: CliIo,
  opts: GlobalOptions,
  issues: ReadonlyArray<RefinoIssue | StorageIssue>,
): number {
  if (opts.json) emit(io, { ok: false, issues });
  else io.stdout.write(`${renderIssues(issues)}\n`);
  return 1;
}

export function emit(io: CliIo, payload: unknown): void {
  // Compact: the primary JSON consumers are programs and agents.
  io.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function fail(io: CliIo, error: unknown): number {
  io.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
}
