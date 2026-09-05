import { buildGraph, checkGroundsChange, IssueCode, isValidConfirmed, validateGraph } from "refino";
import type { Graph, RefinoIssue, RefinoNode } from "refino";
import { loadGraph, nodeRelativeFile, readNode, type StorageIssue } from "@refino/storage";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Issues resident in the index: engine-raised graph issues and storage-raised parse issues. */
type IndexIssue = RefinoIssue | StorageIssue;

/**
 * Process-resident graph index over a `.refino` directory (v1 of the
 * server-side index architecture in docs/design.md).
 *
 * Two memory layers: a light index (id, type, grounds, summary and the small
 * frontmatter fields — the resident graph carries `body: ""`) plus on-demand
 * bodies read back from disk via the path-is-identity rule and kept in an
 * LRU. `validateGraph` runs once at load; afterwards graph issues are
 * recomputed incrementally, scoped to each applied change and its direct
 * dependents, and parse issues are re-stored from every file re-read, so
 * externally introduced problems surface without a full reload.
 *
 * `applyChange` is the single incremental update entry: API writes and
 * external file events both re-read the affected ids from disk through it,
 * so the index is a pure mirror of `.refino/` regardless of write path.
 * Change detection covers the light fields plus the file mtime, so
 * body-only external edits (invisible to the light fields) still bump the
 * revision, reach SSE clients and guard PUT saves against silent
 * overwrites. mtime is a conservative signal: rewriting a file with
 * identical content also counts as a change.
 */

/** SSE payload pushed on /api/events after every applied change batch. */
export interface ChangeEvent {
  revision: number;
  changed: string[];
  deleted: string[];
  /** Write entry that produced an incremental event; absent on snapshots and reloads. */
  origin?: "api" | "file";
  /** Present on full rebuilds: clients refresh wholesale instead of patching. */
  reload?: true;
}

interface Entry {
  /** Resident node record; `body` is always "" (read on demand). */
  node: RefinoNode;
  /** Global revision at which this node last changed. */
  revision: number;
  /** File mtime (ms) captured with the last read; body-level change signal. */
  mtimeMs: number;
}

const BODY_CACHE_MAX = 500;

/** Initial revision after the first full load. */
const INITIAL_REVISION = 1;

export class GraphIndex {
  readonly refinoDir: string;

  #graph: Graph = buildGraph([]);
  #entries = new Map<string, Entry>();
  /**
   * Issue cache in two layers. Parse issues come from reading node files
   * (loader/`readNode` output) and are re-stored whenever a file is re-read;
   * graph issues come from structural checks (`validateGraph` at load,
   * `checkGroundsChange` rechecks afterwards) and are recomputed per applied
   * change and its direct dependents. Both are keyed by node id or by the
   * `.refino`-relative file for issues that never resolved to an id.
   */
  #parseIssues = new Map<string, IndexIssue[]>();
  #graphIssues = new Map<string, IndexIssue[]>();
  #revision = 0;
  #bodies = new Map<string, string>();
  #sortedIds: string[] | undefined;
  #subscribers = new Set<(event: ChangeEvent) => void>();
  /**
   * Constraints pending review (docs/crg.md 1.6): every id that directly
   * depended on a changed node since the last reload / service start.
   * Deleted change targets contribute their pre-mutation dependents. A
   * derived, in-memory state — client acknowledgements live client-side.
   */
  #pendingIds = new Set<string>();

  /** Serialized mutation chain: concurrent API writes, watcher batches and reloads apply atomically. */
  #queue: Promise<unknown> = Promise.resolve();
  #ready: Promise<void> | undefined;

  constructor(refinoDir: string) {
    this.refinoDir = refinoDir;
  }

  /** Full load once per index lifetime; retried after a failed attempt. */
  ready(): Promise<void> {
    this.#ready ??= this.enqueue(() => this.load()).catch((error: unknown) => {
      this.#ready = undefined; // allow the next request to retry the load
      throw error;
    });
    return this.#ready;
  }

  get revision(): number {
    return this.#revision;
  }

  /** The resident light graph (nodes carry `body: ""`). */
  get graph(): Graph {
    return this.#graph;
  }

  entry(id: string): Entry | undefined {
    return this.#entries.get(id);
  }

  /** Issue entries flattened, deduplicated by message and deterministically ordered. */
  issues(): IndexIssue[] {
    const seen = new Set<string>();
    const all: IndexIssue[] = [];
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
  issuesFor(id: string): IndexIssue[] {
    const keys = new Set([id, ...candidateFiles(id)]);
    return this.issues().filter(
      (issue) =>
        (issue.nodeId !== undefined && keys.has(issue.nodeId)) ||
        ("file" in issue && keys.has(issue.file)),
    );
  }

  /** Node body on demand (path is identity), LRU-cached. */
  async readBody(id: string): Promise<string | undefined> {
    if (!this.#entries.has(id)) return undefined;
    const cached = this.#bodies.get(id);
    if (cached !== undefined) {
      this.#bodies.delete(id);
      this.#bodies.set(id, cached);
      return cached;
    }
    const { node } = await readNode(this.refinoDir, id);
    if (node === null) return undefined;
    this.cacheBody(id, node.body);
    return node.body;
  }

  /** Constraints pending review since the last reload / service start, sorted by id. */
  pending(): RefinoNode[] {
    return [...this.#pendingIds]
      .sort()
      .map((id) => this.#graph.nodes.get(id))
      .filter((node): node is RefinoNode => node !== undefined);
  }

  /** Counts for the project-overview cold start; derived from the light index. */
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

  subscribe(handler: (event: ChangeEvent) => void): () => void {
    this.#subscribers.add(handler);
    return () => this.#subscribers.delete(handler);
  }

  /**
   * POST /api/reload: full rescan and index rebuild — the authoritative
   * recovery channel after missed events, watcher loss or service restart.
   * Always bumps the revision so clients refresh.
   */
  reload(): Promise<ChangeEvent> {
    return this.enqueue(async () => {
      const previous = this.#revision;
      await this.load();
      this.#revision = previous + 1;
      for (const entry of this.#entries.values()) entry.revision = this.#revision;
      this.#pendingIds.clear();
      const event: ChangeEvent = {
        revision: this.#revision,
        changed: [],
        deleted: [],
        reload: true,
      };
      this.broadcast(event);
      return event;
    });
  }

  /**
   * The single incremental update entry. Re-reads every id from disk (path
   * is identity), applies additions/updates/removals, and reports only ids
   * whose light fields actually changed — no-ops never bump the revision, so
   * duplicate notifications (an API write followed by its own watcher echo)
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
   * `origin` states the write entry ("api" for HTTP writes, "file" for
   * external watcher events) and rides the broadcast event for review UIs.
   */
  applyChange(change: {
    changed?: readonly string[];
    deleted?: readonly string[];
    shards?: readonly string[];
    origin?: "api" | "file";
  }): Promise<ChangeEvent | undefined> {
    return this.enqueue(async () => {
      const ids = [...new Set([...(change.changed ?? []), ...(change.deleted ?? [])])];
      const touchedShards = [...new Set(change.shards ?? [])];
      if (ids.length === 0 && touchedShards.length === 0) return undefined;

      // Direct dependents captured before mutation: their grounds must be
      // rechecked after the change (e.g. grounds that now dangle).
      const affected = new Set(ids);
      for (const id of ids) {
        for (const dependent of this.#graph.dependents.get(id) ?? []) affected.add(dependent);
      }
      const reads = await Promise.all(ids.map((id) => readNode(this.refinoDir, id)));
      const staleFileIssues = await this.staleFileIssueKeys(touchedShards);

      // From here on the batch applies synchronously: readers never observe a half-applied batch.
      const applied: Array<{ node: RefinoNode; mtimeMs: number; issues: StorageIssue[] }> = [];
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
            removedDependents.set(id, [...(this.#graph.dependents.get(id) ?? [])]);
          }
          // A file that yields no node can still carry parse issues; store
          // them unless an identical batch is already cached (no-op echoes
          // must not bump the revision).
          if (read.issues.length > 0 && this.parseIssuesChanged(id, read.issues)) {
            orphanIssues.push(...read.issues);
          }
        } else if (
          existing === undefined ||
          !sameLightFields(existing.node, read.node) ||
          existing.mtimeMs !== read.mtimeMs
        ) {
          applied.push({ node: read.node, mtimeMs: read.mtimeMs ?? 0, issues: read.issues });
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
      for (const read of applied) this.putNode(read.node, read.mtimeMs, read.issues);
      for (const id of removed) this.removeNode(id);
      for (const key of staleFileIssues) this.#parseIssues.delete(key);
      this.storeParseIssues(orphanIssues);
      this.recheckGraphIssues(affected);

      // Pending review: changed nodes contribute their direct dependents in
      // the new graph; removed nodes their pre-mutation dependents.
      for (const read of applied) {
        for (const dependent of this.#graph.dependents.get(read.node.id) ?? []) {
          this.#pendingIds.add(dependent);
        }
      }
      for (const dependents of removedDependents.values()) {
        for (const dependent of dependents) this.#pendingIds.add(dependent);
      }

      const event: ChangeEvent = {
        revision: this.#revision,
        changed: applied.map((read) => read.node.id),
        deleted: removed,
        ...(change.origin !== undefined && { origin: change.origin }),
      };
      this.broadcast(event);
      return event;
    });
  }

  /** Serialize mutations; a failure never breaks the chain for later callers. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  /** Full rescan; replaces every index structure. */
  private async load(): Promise<void> {
    const { graph, issues, mtimes } = await loadGraph(this.refinoDir);
    const parseMap = new Map<string, IndexIssue[]>();
    for (const issue of issues) storeIssue(parseMap, issue);
    const graphMap = new Map<string, IndexIssue[]>();
    for (const issue of validateGraph(graph)) storeIssue(graphMap, issue);
    const nodes = [...graph.nodes.values()].map((node) => ({ ...node, body: "" }));
    this.#graph = buildGraph(nodes);
    this.#entries = new Map(
      nodes.map((node) => [
        node.id,
        { node, revision: INITIAL_REVISION, mtimeMs: mtimes.get(node.id) ?? 0 },
      ]),
    );
    this.#parseIssues = parseMap;
    this.#graphIssues = graphMap;
    this.#bodies.clear();
    this.#sortedIds = undefined;
    this.#revision = INITIAL_REVISION;
  }

  private putNode(node: RefinoNode, mtimeMs: number, parseIssues: StorageIssue[]): void {
    const existing = this.#entries.get(node.id);
    if (existing !== undefined) this.dropDependents(existing.node);
    const resident = { ...node, body: "" };
    this.#entries.set(node.id, { node: resident, revision: this.#revision, mtimeMs });
    this.#graph.nodes.set(node.id, resident);
    this.addDependents(resident);
    this.dropParseIssues(node.id);
    this.#graphIssues.delete(node.id);
    this.storeParseIssues(parseIssues);
    // The freshly read body warms the LRU for the next readBody.
    this.cacheBody(node.id, node.body);
  }

  private removeNode(id: string): void {
    const existing = this.#entries.get(id);
    if (existing === undefined) return;
    this.dropDependents(existing.node);
    this.#entries.delete(id);
    this.#graph.nodes.delete(id);
    this.#bodies.delete(id);
    this.dropParseIssues(id);
    this.#graphIssues.delete(id);
  }

  private addDependents(node: RefinoNode): void {
    if (node.type !== "constraint") return;
    for (const ground of node.grounds) {
      if (!this.#graph.nodes.has(ground)) continue; // dangling grounds surface as issues, not edges
      const list = this.#graph.dependents.get(ground);
      if (list === undefined) {
        this.#graph.dependents.set(ground, [node.id]);
      } else if (!list.includes(node.id)) {
        list.push(node.id);
        list.sort();
      }
    }
  }

  private dropDependents(node: RefinoNode): void {
    if (node.type !== "constraint") return;
    for (const ground of node.grounds) {
      const list = this.#graph.dependents.get(ground);
      if (list === undefined) continue;
      const filtered = list.filter((id) => id !== node.id);
      if (filtered.length === 0) this.#graph.dependents.delete(ground);
      else this.#graph.dependents.set(ground, filtered);
    }
  }

  /**
   * Incremental graph-issue recheck scoped to the affected ids and their
   * former direct dependents: per-node grounds issues come from the engine's
   * `checkGroundsChange` (a cycle must pass through an affected node, and
   * dangling grounds only appear on nodes grounding on changed ids), the
   * confirmed format check complements it. Parse issues are untouched (they
   * are re-stored from the file reads) and issues elsewhere in the graph are
   * unaffected by the change and stay cached.
   */
  private recheckGraphIssues(affected: Iterable<string>): void {
    for (const id of affected) {
      this.#graphIssues.delete(id);
      const entry = this.#entries.get(id);
      if (entry === undefined) continue;
      const found: RefinoIssue[] = [];
      const { node } = entry;
      if (node.type === "premise") {
        if (node.confirmed !== undefined && !isValidConfirmed(node.confirmed)) {
          found.push({
            code: IssueCode.InvalidConfirmed,
            message: `"confirmed" must be an RFC 3339 timestamp with an explicit UTC offset (Z or ±HH:MM), got "${node.confirmed}".`,
            nodeId: node.id,
          });
        }
      } else {
        found.push(...checkGroundsChange(this.#graph, node, node.grounds));
      }
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

  private cacheBody(id: string, body: string): void {
    this.#bodies.delete(id);
    this.#bodies.set(id, body);
    if (this.#bodies.size > BODY_CACHE_MAX) {
      const oldest = this.#bodies.keys().next().value;
      if (oldest !== undefined) this.#bodies.delete(oldest);
    }
  }

  private broadcast(event: ChangeEvent): void {
    for (const handler of this.#subscribers) {
      try {
        handler(event);
      } catch {
        // a broken SSE client must never break change application
      }
    }
  }
}

/** Both candidate file paths of an id, in canonical `.refino`-relative form. */
function candidateFiles(id: string): string[] {
  return (["constraint", "premise"] as const).map((type) => nodeRelativeFile(type, id));
}

/** Group one issue into a keyed cache under its node id or, failing that, its file. */
function storeIssue(cache: Map<string, IndexIssue[]>, issue: IndexIssue): void {
  const key = issue.nodeId ?? ("file" in issue ? issue.file : undefined);
  if (key === undefined) return;
  const list = cache.get(key);
  if (list) list.push(issue);
  else cache.set(key, [issue]);
}

/**
 * Change detection over the light fields the resident index tracks. Body
 * content is intentionally excluded (bodies are not resident; body-only
 * external edits surface on reload). Read bodies come in with the node but
 * are dropped when the entry is stored.
 */
function sameLightFields(previous: RefinoNode, read: RefinoNode): boolean {
  if (previous.type !== read.type) return false;
  if (previous.summary !== read.summary) return false;
  // Same discriminant: narrow once and compare the type's own fields.
  if (previous.type === "premise" && read.type === "premise") {
    return previous.confirmed === read.confirmed;
  }
  return (
    previous.type === "constraint" &&
    read.type === "constraint" &&
    previous.rationale === read.rationale &&
    sameGrounds(previous.grounds, read.grounds)
  );
}

function sameGrounds(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  return a.every((id, i) => id === b[i]);
}
