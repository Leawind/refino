import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  addNode,
  buildGraph,
  checkGroundsChange,
  generateId,
  IssueCode,
  RefinoError,
  removeNode,
  updateNode,
  validateGraph,
  type Graph,
  type GraphNode,
  type RefinoIssue,
  type RefinoNode,
} from "refino";
import { loadGraph, readNode } from "./loader.js";
import {
  createConstraint,
  createPremise,
  deleteNode,
  nodeRelativeFile,
  updateConstraint,
  updatePremise,
} from "./writer.js";
import type {
  CreateConstraintOptions,
  CreatePremiseOptions,
  UpdateConstraintOptions,
  UpdatePremiseOptions,
} from "./writer.js";
import type { StorageIssue } from "./codes.js";
import type { NodeContent } from "./parser.js";
import { startNodeWatcher, type NodeWatcher, type NodeWatcherOptions } from "./watcher.js";

/** Issues resident in the store: engine-raised graph issues and storage-raised parse issues. */
export type StoreIssue = RefinoIssue | StorageIssue;

/**
 * One change batch applied to the store. API writes and external file events
 * go through the same entry, so every consumer sees the same shape; the
 * pending-review accumulation policy, SSE envelopes and origin presentation
 * belong to the consumers, not the store.
 */
export interface StoreChange {
  revision: number;
  changed: string[];
  deleted: string[];
  /**
   * Direct dependents (one hop) of the changed nodes in the new graph plus
   * the removed nodes' pre-mutation dependents — the pending-review raw
   * material (docs/crg.md 1.6). Sorted, deduplicated.
   */
  affected: string[];
  /** Write entry that produced an incremental event; absent on snapshots and reloads. */
  origin?: "api" | "file";
  /** Present on full rebuilds: clients refresh wholesale instead of patching. */
  reload?: true;
}

export interface StoreEntry {
  /** Resident graph-attached node record; body and rationale are paged. */
  node: GraphNode;
  /** Global revision at which this node last changed. */
  revision: number;
  /** File mtime (ms) captured with the last read; content-level change signal. */
  mtimeMs: number;
  /** Whether the summary came from an explicit frontmatter field (not derived from the body). */
  summaryExplicit: boolean;
}

/** Result of a store write: the written id and the applied change batch. */
export interface WriteOutcome {
  id: string;
  /** Undefined when the write turned out to be a no-op (identical file state). */
  change?: StoreChange;
}

/**
 * Thrown by the store's write methods when pre-write validation rejects the
 * change (grounds that do not resolve, close a cycle, or repeat an id).
 * Carries the issues so consumers can present them; hard storage errors
 * (unknown id, duplicate id, bad RFC 3339 confirmed) stay `RefinoError`.
 */
export class WriteRejected extends Error {
  readonly issues: StoreIssue[];

  constructor(issues: StoreIssue[]) {
    super("The change was rejected by grounds validation.");
    this.name = "WriteRejected";
    this.issues = issues;
  }
}

const CONTENT_CACHE_MAX = 500;

/** Initial revision after the first full load. */
const INITIAL_REVISION = 1;

export interface RefinoStoreOptions {
  /**
   * Watch `nodes/` for external changes and feed them through the same
   * incremental entry as the write methods. Long-lived consumers (web
   * server, tool-plugin hosts) enable it; one-shot consumers (CLI) do not.
   * Watching degrades silently when the platform cannot.
   */
  watch?: boolean | { debounceMs?: number };
}

/**
 * Stateful resident projection of a `.refino/` directory (docs/design.md,
 * "存储层 Store"): the authoritative data lives in the files, the store
 * mirrors it in memory (resident graph + paged content LRU + issue caches)
 * and keeps the projection consistent with the disk by construction — every
 * write method validates, persists atomically, re-reads the file and applies
 * the parsed result through the engine's mutation primitives in one call,
 * then broadcasts the change. API writes and external file events share the
 * single incremental entry, so forgetting to sync the projection is
 * impossible.
 */
export class RefinoStore {
  readonly refinoDir: string;

  #graph: Graph = buildGraph([]);
  #entries = new Map<string, StoreEntry>();
  /**
   * Issue cache in two layers. Parse issues come from reading node files
   * (loader/`readNode` output) and are re-stored whenever a file is re-read;
   * graph issues come from structural checks (`validateGraph` at load,
   * `checkGroundsChange` rechecks afterwards) and are recomputed per applied
   * change and its direct dependents. Both are keyed by node id or by the
   * `.refino`-relative file for issues that never resolved to an id.
   */
  #parseIssues = new Map<string, StoreIssue[]>();
  #graphIssues = new Map<string, StoreIssue[]>();
  #revision = 0;
  #contents = new Map<string, NodeContent>();
  #sortedIds: string[] | undefined;
  #subscribers = new Set<(change: StoreChange) => void>();
  #watcher: NodeWatcher | undefined;

  /** Serialized mutation chain: concurrent writes, watcher batches and reloads apply atomically. */
  #queue: Promise<unknown> = Promise.resolve();
  #ready: Promise<void> | undefined;

  private constructor(refinoDir: string) {
    this.refinoDir = refinoDir;
  }

  /**
   * Create a store over the directory. Loading is lazy and retried: await
   * `ready()` before reading, and a failed load (e.g. a missing directory
   * the caller treats as recoverable) surfaces through `ready()` again on
   * the next call. With `watch`, external changes enter the same incremental
   * entry as the write methods.
   */
  static open(refinoDir: string, options: RefinoStoreOptions = {}): RefinoStore {
    const store = new RefinoStore(refinoDir);
    if (options.watch !== undefined && options.watch !== false) {
      const debounce = typeof options.watch === "object" ? options.watch.debounceMs : undefined;
      void store.ready().catch(() => {}); // watcher events may arrive before the first load
      const watcherOptions: NodeWatcherOptions =
        debounce === undefined ? {} : { debounceMs: debounce };
      store.#watcher = startNodeWatcher(
        join(refinoDir, "nodes"),
        (ids, shards) => {
          void store.applyChange({ changed: ids, shards, origin: "file" }).catch(() => {
            // a failed batch keeps the previous state; the next batch retries
          });
        },
        watcherOptions,
      );
    }
    return store;
  }

  /** Full load once per store lifetime; retried after a failed attempt. */
  ready(): Promise<void> {
    this.#ready ??= this.enqueue(() => this.load()).catch((error: unknown) => {
      this.#ready = undefined; // allow the next call to retry the load
      throw error;
    });
    return this.#ready;
  }

  /** Stop watching; the store stays readable but no longer syncs external changes. */
  close(): void {
    this.#watcher?.close();
    this.#watcher = undefined;
  }

  get revision(): number {
    return this.#revision;
  }

  /** The resident graph (topology and summaries; content is paged). */
  get graph(): Graph {
    return this.#graph;
  }

  entry(id: string): StoreEntry | undefined {
    return this.#entries.get(id);
  }

  /** Issue entries flattened, deduplicated by message and deterministically ordered. */
  issues(): StoreIssue[] {
    const seen = new Set<string>();
    const all: StoreIssue[] = [];
    for (const list of [...this.#parseIssues.values(), ...this.#graphIssues.values()]) {
      for (const issue of list) {
        if (seen.has(issue.message)) continue;
        seen.add(issue.message);
        all.push(issue);
      }
    }
    return all.sort((a, b) =>
      a.code === b.code ? (a.message < b.message ? -1 : 1) : a.code < b.code ? -1 : 1,
    );
  }

  /** Issues that relate to the given node (by id or by its candidate files). */
  issuesFor(id: string): StoreIssue[] {
    const keys = new Set([id, ...candidateFiles(id)]);
    return this.issues().filter(
      (issue) =>
        (issue.nodeId !== undefined && keys.has(issue.nodeId)) ||
        ("file" in issue && keys.has(issue.file)),
    );
  }

  /** Node content on demand (path is identity), LRU-cached. */
  async content(id: string): Promise<NodeContent | undefined> {
    if (!this.#entries.has(id)) return undefined;
    const cached = this.#contents.get(id);
    if (cached !== undefined) {
      this.#contents.delete(id);
      this.#contents.set(id, cached);
      return cached;
    }
    const read = await readNode(this.refinoDir, id);
    if (read.content === undefined) return undefined;
    this.cacheContent(id, read.content);
    return read.content;
  }

  /** Counts for project-overview cold starts; derived from the resident graph. */
  stats(): { nodes: number; constraints: number; premises: number; roots: number } {
    let constraints = 0;
    let premises = 0;
    let roots = 0;
    for (const node of this.#graph.nodes.values()) {
      if (node.type === "premise") {
        premises++;
      } else {
        constraints++;
        if (node.grounds.length === 0) roots++;
      }
    }
    return { nodes: constraints + premises, constraints, premises, roots };
  }

  /** Ids in ascending order; the sorted view is cached and invalidated on writes. */
  sortedIds(): string[] {
    this.#sortedIds ??= [...this.#entries.keys()].sort();
    return this.#sortedIds;
  }

  /** Subscribe to applied change batches; returns the unsubscribe function. */
  onChange(handler: (change: StoreChange) => void): () => void {
    this.#subscribers.add(handler);
    return () => this.#subscribers.delete(handler);
  }

  /**
   * POST /api/reload equivalent: full rescan and projection rebuild — the
   * authoritative recovery channel after missed events, watcher loss or
   * service restart. Always bumps the revision so clients refresh.
   */
  reload(): Promise<StoreChange> {
    return this.enqueue(async () => {
      const previous = this.#revision;
      await this.load();
      this.#revision = previous + 1;
      for (const entry of this.#entries.values()) entry.revision = this.#revision;
      const change: StoreChange = {
        revision: this.#revision,
        changed: [],
        deleted: [],
        affected: [],
        reload: true,
      };
      this.broadcast(change);
      return change;
    });
  }

  /**
   * The single incremental update entry. Re-reads every id from disk (path
   * is identity), applies additions/updates/removals, and reports only ids
   * whose resident fields actually changed — no-ops never bump the revision,
   * so duplicate notifications (a write followed by its own watcher echo)
   * stay silent. Every re-read's parse issues are (re)stored, so externally
   * introduced problems surface here as they do on a full load.
   *
   * `shards` are directories touched by the incoming file events. Parse
   * issues are keyed by file for nodes whose id never resolved (invalid id
   * shape, duplicate id, ...), and such files are invisible to id-based
   * reporting — a rename or delete of one would leave its issue stuck. For
   * each touched shard, file-keyed issues whose file has vanished are
   * dropped; surviving files keep their issues (their content is re-read
   * through the ids anyway).
   *
   * `origin` states the write entry ("api" for the store's own write
   * methods, "file" for external watcher events) and rides the broadcast.
   */
  applyChange(change: {
    changed?: readonly string[];
    deleted?: readonly string[];
    shards?: readonly string[];
    origin?: "api" | "file";
  }): Promise<StoreChange | undefined> {
    return this.enqueue(() => this.apply(change));
  }

  // ---- write methods: validate -> persist -> re-read -> apply -> broadcast ----

  /** Create a premise node file; no grounds validation applies. */
  async createPremise(opts: CreatePremiseOptions): Promise<WriteOutcome> {
    return this.enqueue(async () => {
      const id = await createPremise(this.refinoDir, opts);
      return { id, change: await this.apply({ changed: [id], origin: "api" }) };
    });
  }

  /**
   * Create a constraint node file. The grounds are validated before
   * persisting (unknown references, duplicates; a brand-new node cannot
   * close a cycle), so rejected writes never touch the disk.
   */
  async createConstraint(opts: CreateConstraintOptions): Promise<WriteOutcome> {
    return this.enqueue(async () => {
      const grounds = opts.grounds ?? [];
      // The id is generated by the writer when omitted; validation only
      // needs a target id that cannot be reached by existing grounds edges.
      const probeId = opts.id ?? this.probeId();
      const issues = checkGroundsChange(
        this.#graph,
        { id: probeId, type: "constraint", summary: "", grounds },
        grounds,
      );
      if (issues.length > 0) throw new WriteRejected(issues);
      const id = await createConstraint(this.refinoDir, opts);
      return { id, change: await this.apply({ changed: [id], origin: "api" }) };
    });
  }

  /** Overwrite a premise node file. */
  async updatePremise(id: string, opts: UpdatePremiseOptions): Promise<WriteOutcome> {
    return this.enqueue(async () => {
      this.requireEntry(id, "premise");
      await updatePremise(this.refinoDir, id, opts);
      return { id, change: await this.apply({ changed: [id], origin: "api" }) };
    });
  }

  /**
   * Overwrite a constraint node file. Non-empty grounds are validated before
   * persisting (unknown references, duplicates, cycles the change would
   * close), so rejected writes never touch the disk.
   */
  async updateConstraint(id: string, opts: UpdateConstraintOptions): Promise<WriteOutcome> {
    return this.enqueue(async () => {
      const entry = this.requireEntry(id, "constraint");
      const node = entry.node;
      if (node.type !== "constraint") {
        throw new RefinoError(IssueCode.NodeNotFound, `Node "${id}" does not exist.`);
      }
      if (opts.grounds !== undefined) {
        const issues = checkGroundsChange(this.#graph, node, opts.grounds);
        if (issues.length > 0) throw new WriteRejected(issues);
      }
      await updateConstraint(this.refinoDir, id, opts);
      return { id, change: await this.apply({ changed: [id], origin: "api" }) };
    });
  }

  /**
   * Delete a node file. Referencing nodes are left untouched — dangling
   * grounds surface as UNKNOWN_GROUND issues on the applied change; whether
   * deletion may leave them behind is the caller's policy.
   */
  async deleteNode(id: string): Promise<WriteOutcome> {
    return this.enqueue(async () => {
      await deleteNode(this.refinoDir, id);
      return { id, change: await this.apply({ deleted: [id], origin: "api" }) };
    });
  }

  // ---- internals ----

  /** The resident entry for a write target; NODE_NOT_FOUND when absent or of the other type. */
  private requireEntry(id: string, type: "premise" | "constraint"): StoreEntry {
    const entry = this.#entries.get(id);
    if (entry === undefined || entry.node.type !== type) {
      throw new RefinoError(IssueCode.NodeNotFound, `Node "${id}" does not exist.`);
    }
    return entry;
  }

  /** An id absent from the resident graph, for write-time validation probes. */
  private probeId(): string {
    let id = generateId();
    while (this.#graph.nodes.has(id)) id = generateId();
    return id;
  }

  /** Serialize mutations; a failure never breaks the chain for later callers. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  /** Full rescan; replaces every projection structure. */
  private async load(): Promise<void> {
    const { graph, issues, mtimes, summaryExplicit } = await loadGraph(this.refinoDir);
    const parseMap = new Map<string, StoreIssue[]>();
    for (const issue of issues) storeIssue(parseMap, issue);
    const graphMap = new Map<string, StoreIssue[]>();
    for (const issue of validateGraph(graph)) storeIssue(graphMap, issue);
    this.#graph = graph;
    this.#entries = new Map(
      [...graph.nodes.values()].map((node) => [
        node.id,
        {
          node,
          revision: INITIAL_REVISION,
          mtimeMs: mtimes.get(node.id) ?? 0,
          summaryExplicit: summaryExplicit.get(node.id) ?? false,
        },
      ]),
    );
    this.#parseIssues = parseMap;
    this.#graphIssues = graphMap;
    this.#contents.clear();
    this.#sortedIds = undefined;
    this.#revision = INITIAL_REVISION;
  }

  /** The synchronous apply half of `applyChange`; write methods call it inside their own enqueue. */
  private async apply(change: {
    changed?: readonly string[];
    deleted?: readonly string[];
    shards?: readonly string[];
    origin?: "api" | "file";
  }): Promise<StoreChange | undefined> {
    const ids = [...new Set([...(change.changed ?? []), ...(change.deleted ?? [])])];
    const touchedShards = [...new Set(change.shards ?? [])];
    if (ids.length === 0 && touchedShards.length === 0) return undefined;

    // Direct dependents captured before mutation: their grounds must be
    // rechecked after the change (e.g. grounds that now dangle).
    const affected = new Set(ids);
    for (const id of ids) {
      for (const dependent of this.#graph.nodes.get(id)?.children ?? []) affected.add(dependent);
    }
    const reads = await Promise.all(ids.map((id) => readNode(this.refinoDir, id)));
    const staleFileIssues = await this.staleFileIssueKeys(touchedShards);

    // From here on the batch applies synchronously: readers never observe a half-applied batch.
    const applied: Array<{
      node: RefinoNode;
      content?: NodeContent;
      mtimeMs: number;
      summaryExplicit: boolean;
      issues: StorageIssue[];
    }> = [];
    const removed: string[] = [];
    /** Pre-mutation direct dependents of removed ids — they review the removal. */
    const removedDependents = new Map<string, string[]>();
    /** Parse issues of files that produced no node (e.g. broken YAML). */
    const orphanIssues: StorageIssue[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const read = reads[i]!;
      const existing = this.#entries.get(id);
      if (read.node === null) {
        if (existing !== undefined) {
          removed.push(id);
          removedDependents.set(id, [...existing.node.children]);
        }
        // A file that yields no node can still carry parse issues; store
        // them unless an identical batch is already cached (no-op echoes
        // must not bump the revision).
        if (read.issues.length > 0 && this.parseIssuesChanged(id, read.issues)) {
          orphanIssues.push(...read.issues);
        }
      } else if (
        existing === undefined ||
        !sameResidentFields(existing.node, read.node) ||
        existing.mtimeMs !== read.mtimeMs
      ) {
        applied.push({
          node: read.node,
          content: read.content,
          mtimeMs: read.mtimeMs ?? 0,
          summaryExplicit: read.summaryExplicit ?? false,
          issues: read.issues,
        });
      }
    }
    if (
      applied.length === 0 &&
      removed.length === 0 &&
      orphanIssues.length === 0 &&
      staleFileIssues.length === 0
    ) {
      return undefined;
    }

    this.#revision++;
    this.#sortedIds = undefined;
    for (const read of applied) {
      this.putEntry(read.node, read.content, read.mtimeMs, read.summaryExplicit, read.issues);
    }
    for (const id of removed) this.dropEntry(id);
    for (const key of staleFileIssues) this.#parseIssues.delete(key);
    this.storeParseIssues(orphanIssues);
    this.recheckGraphIssues(affected);

    // The change's affected set: changed nodes contribute their direct
    // dependents in the new graph; removed nodes their pre-mutation ones.
    const changeAffected = new Set<string>();
    for (const read of applied) {
      for (const dependent of this.#graph.nodes.get(read.node.id)?.children ?? []) {
        changeAffected.add(dependent);
      }
    }
    for (const dependents of removedDependents.values()) {
      for (const dependent of dependents) changeAffected.add(dependent);
    }

    const event: StoreChange = {
      revision: this.#revision,
      changed: applied.map((read) => read.node.id),
      deleted: removed,
      affected: [...changeAffected].sort(),
      ...(change.origin !== undefined && { origin: change.origin }),
    };
    this.broadcast(event);
    return event;
  }

  private putEntry(
    node: RefinoNode,
    content: NodeContent | undefined,
    mtimeMs: number,
    summaryExplicit: boolean,
    parseIssues: StorageIssue[],
  ): void {
    // Engine primitives keep the children back-references consistent; the
    // resident record replaces summary, confirmed and grounds wholesale.
    // An id re-created as the other type (external deletion + re-creation
    // between two reads) must replace the node wholesale: updateNode keeps
    // the attached type fixed.
    const existing = this.#graph.nodes.get(node.id);
    if (existing === undefined) addNode(this.#graph, node);
    else if (existing.type !== node.type) {
      removeNode(this.#graph, node.id);
      addNode(this.#graph, node);
    } else updateNode(this.#graph, node);
    this.#entries.set(node.id, {
      node: this.#graph.nodes.get(node.id)!,
      revision: this.#revision,
      mtimeMs,
      summaryExplicit,
    });
    this.dropParseIssues(node.id);
    this.#graphIssues.delete(node.id);
    this.storeParseIssues(parseIssues);
    // The freshly read content warms the LRU for the next content() read.
    if (content !== undefined) this.cacheContent(node.id, content);
  }

  private dropEntry(id: string): void {
    const existing = this.#entries.get(id);
    if (existing === undefined) return;
    removeNode(this.#graph, id);
    this.#entries.delete(id);
    this.#contents.delete(id);
    this.dropParseIssues(id);
    this.#graphIssues.delete(id);
  }

  /**
   * Incremental graph-issue recheck scoped to the affected ids and their
   * former direct dependents: per-node grounds issues come from the engine's
   * `checkGroundsChange` (a cycle must pass through an affected node, and
   * dangling grounds only appear on nodes grounding on changed ids). Premise
   * checks happen at the file boundary (parse issues); parse issues are
   * re-stored from the file reads, and issues elsewhere in the graph are
   * unaffected by the change and stay cached.
   */
  private recheckGraphIssues(affected: Iterable<string>): void {
    for (const id of affected) {
      this.#graphIssues.delete(id);
      const entry = this.#entries.get(id);
      if (entry === undefined) continue;
      const { node } = entry;
      if (node.type !== "constraint") continue; // edges only come from constraint grounds
      const found = checkGroundsChange(this.#graph, node, node.grounds);
      if (found.length > 0) this.#graphIssues.set(id, found);
    }
  }

  /** Group parse issues by node id or file and merge them into the cache. */
  private storeParseIssues(issues: readonly StorageIssue[]): void {
    for (const issue of issues) storeIssue(this.#parseIssues, issue);
  }

  /** Drop every parse-issue entry that can relate to the id, including file-keyed ones. */
  private dropParseIssues(id: string): void {
    this.#parseIssues.delete(id);
    for (const file of candidateFiles(id)) this.#parseIssues.delete(file);
  }

  /**
   * Whether the cached parse issues under the id's keys differ from the
   * given fresh batch (compared by message set). Guards the revision against
   * no-op echoes of an unchanged, unparseable file.
   */
  private parseIssuesChanged(id: string, fresh: readonly StorageIssue[]): boolean {
    const keys = new Set([id, ...candidateFiles(id)]);
    const cached = new Set<string>();
    for (const list of this.#parseIssues.values()) {
      for (const issue of list) {
        if (
          (issue.nodeId !== undefined && keys.has(issue.nodeId)) ||
          ("file" in issue && keys.has(issue.file))
        ) {
          cached.add(issue.message);
        }
      }
    }
    if (cached.size !== fresh.length) return true;
    return fresh.some((issue) => !cached.has(issue.message));
  }

  /**
   * File-keyed parse-issue entries whose file no longer exists, within the
   * given shards (issue keys are node ids or `.refino`-relative file paths;
   * only file paths live under `nodes/<shard>/`). Must run before the
   * synchronous apply section — readers never observe a half-applied batch.
   */
  private async staleFileIssueKeys(shards: readonly string[]): Promise<string[]> {
    const stale: string[] = [];
    for (const shard of shards) {
      const prefix = `nodes/${shard}/`;
      const files = await readdir(join(this.refinoDir, "nodes", shard)).catch((): string[] => []);
      for (const key of this.#parseIssues.keys()) {
        if (key.startsWith(prefix) && !files.includes(key.slice(prefix.length))) stale.push(key);
      }
    }
    return stale;
  }

  private cacheContent(id: string, content: NodeContent): void {
    this.#contents.delete(id);
    this.#contents.set(id, content);
    if (this.#contents.size > CONTENT_CACHE_MAX) {
      const oldest = this.#contents.keys().next().value;
      if (oldest !== undefined) this.#contents.delete(oldest);
    }
  }

  private broadcast(change: StoreChange): void {
    for (const handler of this.#subscribers) {
      try {
        handler(change);
      } catch {
        // a broken subscriber must never break change application
      }
    }
  }
}

/** Both candidate file paths of an id, in canonical `.refino`-relative form. */
function candidateFiles(id: string): string[] {
  return (["constraint", "premise"] as const).map((type) => nodeRelativeFile(type, id));
}

/** Group one issue into a keyed cache under its node id or, failing that, its file. */
function storeIssue(cache: Map<string, StoreIssue[]>, issue: StoreIssue): void {
  const key = issue.nodeId ?? ("file" in issue ? issue.file : undefined);
  if (key === undefined) return;
  const list = cache.get(key);
  if (list) list.push(issue);
  else cache.set(key, [issue]);
}

/**
 * Change detection over the resident fields the store tracks. Paged content
 * (body, rationale) is intentionally excluded — it is not resident, and
 * content-only external edits surface through the file mtime instead.
 */
function sameResidentFields(previous: RefinoNode, read: RefinoNode): boolean {
  if (previous.type !== read.type) return false;
  if (previous.summary !== read.summary) return false;
  // Same discriminant: narrow once and compare the type's own fields.
  if (previous.type === "premise" && read.type === "premise") {
    return previous.confirmed === read.confirmed;
  }
  return (
    previous.type === "constraint" &&
    read.type === "constraint" &&
    sameGrounds(previous.grounds, read.grounds)
  );
}

function sameGrounds(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  return a.every((id, i) => id === b[i]);
}
