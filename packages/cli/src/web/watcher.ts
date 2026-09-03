import { watch, readdirSync, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Watches the sharded node directory for external changes (docs/design.md,
 * "外部变更同步"). Non-recursive on purpose: recursive watching is
 * unavailable on Linux, so there is one watch on `nodes/` plus one per shard
 * directory — at most 1025 watches, and shard directories are created
 * lazily as ids are generated.
 *
 * File events report the affected node id (shard name + file base) plus the
 * shard directory itself. Ids cover everything that matches the node file
 * shape; the shard names let the index drop parse issues keyed by files that
 * no longer exist (an ill-shaped file is never reported as an id, so a
 * rename or delete of one would otherwise leave its load-phase issue stuck).
 * A newly created shard is scanned wholesale because its first files may
 * predate the shard's own watcher. Events are debounced: after a quiet
 * period the accumulated ids flush as one batch into the index's unified
 * update entry.
 *
 * Watch initialization failures return undefined — the server silently
 * degrades to manual refresh (POST /api/reload). Removing a whole shard
 * directory is likewise not reported per id and needs a manual reload.
 */

/** A shard directory name: the first 2 characters of a node id. */
const SHARD_RE = /^[0-9A-HJKMNP-TV-Z]{2}$/;

/** A node file base name inside a shard: the last 6 characters of a node id. */
const FILE_RE = /^[0-9A-HJKMNP-TV-Z]{6}\.(premise|constraint)\.md$/;

export interface NodeWatcher {
  close(): void;
}

export interface NodeWatcherOptions {
  /** Quiet period in ms; events inside it coalesce into one batch. */
  debounceMs?: number;
}

export function startNodeWatcher(
  nodesDir: string,
  onBatch: (ids: string[], shards: string[]) => void,
  options: NodeWatcherOptions = {},
): NodeWatcher | undefined {
  let root: FSWatcher;
  try {
    root = watch(nodesDir);
  } catch {
    return undefined; // dir missing or watching unavailable: manual refresh only
  }

  const debounceMs = options.debounceMs ?? 500;
  const shards = new Map<string, FSWatcher>();
  const pending = new Set<string>();
  /** Shards touched by any file event, well-shaped or not. */
  const dirtyShards = new Set<string>();
  /** Shards needing a second scan: files may land between the first scan and the shard watcher attach. */
  const rescanPending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    timer = undefined;
    // Deferred shard rescans queue their ids now; they flush after the next quiet period.
    for (const name of rescanPending) scanShard(name);
    rescanPending.clear();
    if (pending.size === 0 && dirtyShards.size === 0) return;
    const ids = [...pending];
    const dirty = [...dirtyShards];
    pending.clear();
    dirtyShards.clear();
    onBatch(ids, dirty);
  };
  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
    timer.unref?.(); // never keep the process alive for a pending batch
  };
  const queue = (id: string): void => {
    pending.add(id);
    schedule();
  };

  /** List a shard directory and queue every node file found in it. */
  const scanShard = (name: string): void => {
    void readdir(join(nodesDir, name))
      .then((files) => {
        for (const file of files) {
          if (FILE_RE.test(file)) queue(name + file.slice(0, 6));
        }
      })
      .catch(() => {}); // vanished mid-scan: deletion surfaces via id events or reload
  };

  const watchShard = (name: string): void => {
    if (shards.has(name)) return;
    let shard: FSWatcher;
    try {
      shard = watch(join(nodesDir, name));
    } catch {
      return; // e.g. removed again immediately; root events keep retrying
    }
    shards.set(name, shard);
    // The FSWatcher EventEmitter event is always "change"; the first
    // callback argument distinguishes "rename" (create/delete/atomic
    // replace) from "change" (in-place modify). Both resolve via readNode.
    const onFileEvent = (_eventType: string, filename: string | Buffer | null): void => {
      dirtyShards.add(name);
      if (filename === null) {
        scanShard(name); // platform gave no name: rescan the shard
        return;
      }
      const file = filename.toString();
      if (FILE_RE.test(file)) queue(name + file.slice(0, 6));
      // Temp files from atomic writes never match the node shape and are ignored.
    };
    shard.on("change", onFileEvent);
    shard.on("error", () => {}); // a removed shard must not crash the process
  };

  const unwatchShard = (name: string): void => {
    shards.get(name)?.close();
    shards.delete(name);
  };

  // Attach a watcher to every shard that already exists (at most 1024 shard
  // watches plus the root watch); shards are created lazily as ids are
  // generated. Writes into a pre-existing shard are invisible otherwise.
  for (const entry of readdirSync(nodesDir, { withFileTypes: true })) {
    if (entry.isDirectory() && SHARD_RE.test(entry.name)) watchShard(entry.name);
  }

  // The root FSWatcher event is always "change"; "rename" as eventType
  // signals a shard directory appearing or disappearing.
  root.on("change", (_eventType: string, filename: string | Buffer | null) => {
    if (filename === null) return;
    const name = filename.toString();
    if (!SHARD_RE.test(name)) return;
    // A shard appearing gets a watcher, an immediate scan, and a deferred
    // second scan after the quiet period: its first files may be written
    // before inotify delivers the directory event, so neither the watcher
    // nor the immediate scan alone can see them. A shard disappearing drops
    // its watcher — the id-level deletions are covered by reload.
    watchShard(name);
    scanShard(name);
    dirtyShards.add(name);
    rescanPending.add(name);
    schedule();
  });
  root.on("error", () => {});

  return {
    close(): void {
      root.close();
      for (const name of [...shards.keys()]) unwatchShard(name);
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
