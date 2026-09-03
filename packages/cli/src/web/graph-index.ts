import { buildGraph, checkGroundsChange, isValidConfirmed, validateGraph } from "refino";
import type { Graph, RefinoIssue, RefinoNode } from "refino";
import { loadGraph, readNode } from "@refino/storage";

/**
 * Process-resident graph index over a `.refino` directory (v1 of the
 * server-side index architecture in docs/design.md).
 *
 * Two memory layers: a light index (id, type, grounds, summary and the small
 * frontmatter fields — the resident graph carries `body: ""`) plus on-demand
 * bodies read back from disk via the path-is-identity rule and kept in an
 * LRU. `validateGraph` runs once at load; afterwards issue entries are
 * updated incrementally, scoped to each applied change and its direct
 * dependents.
 *
 * `applyChange` is the single incremental update entry: API writes and
 * external file events both re-read the affected ids from disk through it,
 * so the index is a pure mirror of `.refino/` regardless of write path.
 * Note that body-only external edits are invisible to the light index and
 * surface on the next full rebuild (`reload`, POST /api/reload).
 */

/** SSE payload pushed on /api/events after every applied change batch. */
export interface ChangeEvent {
  revision: number;
  changed: string[];
  deleted: string[];
  /** Present on full rebuilds: clients refresh wholesale instead of patching. */
  reload?: true;
}

interface Entry {
  /** Resident node record; `body` is always "" (read on demand). */
  node: RefinoNode;
  /** Global revision at which this node last changed. */
  revision: number;
}

const BODY_CACHE_MAX = 500;

/** Initial revision after the first full load. */
const INITIAL_REVISION = 1;

export class GraphIndex {
  readonly refinoDir: string;

  #graph: Graph = buildGraph("", []);
  #entries = new Map<string, Entry>();
  #issues = new Map<string, RefinoIssue[]>();
  #revision = 0;
  #bodies = new Map<string, string>();
  #sortedIds: string[] | undefined;
  #subscribers = new Set<(event: ChangeEvent) => void>();

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
  issues(): RefinoIssue[] {
    const seen = new Set<string>();
    const all: RefinoIssue[] = [];
    for (const list of this.#issues.values()) {
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
  issuesFor(id: string): RefinoIssue[] {
    const keys = new Set([id, ...candidateFiles(id)]);
    return this.issues().filter(
      (issue) =>
        (issue.nodeId !== undefined && keys.has(issue.nodeId)) ||
        (issue.file !== undefined && keys.has(issue.file)),
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
   * stay silent.
   */
  applyChange(change: {
    changed?: readonly string[];
    deleted?: readonly string[];
  }): Promise<ChangeEvent | undefined> {
    return this.enqueue(async () => {
      const ids = [...new Set([...(change.changed ?? []), ...(change.deleted ?? [])])];
      if (ids.length === 0) return undefined;

      // Direct dependents captured before mutation: their grounds must be
      // rechecked after the change (e.g. grounds that now dangle).
      const affected = new Set(ids);
      for (const id of ids) {
        for (const dependent of this.#graph.dependents.get(id) ?? []) affected.add(dependent);
      }
      const reads = await Promise.all(ids.map((id) => readNode(this.refinoDir, id)));

      // From here on the batch applies synchronously: readers never observe a half-applied batch.
      const applied: RefinoNode[] = [];
      const removed: string[] = [];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]!;
        const read = reads[i]!;
        const existing = this.#entries.get(id);
        if (read.node === null) {
          if (existing !== undefined) removed.push(id);
        } else if (existing === undefined || !sameLightFields(existing.node, read.node)) {
          applied.push(read.node);
        }
      }
      if (applied.length === 0 && removed.length === 0) return undefined;

      this.#revision++;
      this.#sortedIds = undefined;
      for (const node of applied) this.putNode(node);
      for (const id of removed) this.removeNode(id);
      this.recheckIssues(affected);

      const event: ChangeEvent = {
        revision: this.#revision,
        changed: applied.map((n) => n.id),
        deleted: removed,
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
    const { graph, issues } = await loadGraph(this.refinoDir);
    const issueMap = new Map<string, RefinoIssue[]>();
    for (const issue of [...issues, ...validateGraph(graph)]) {
      const key = issue.nodeId ?? issue.file;
      if (key === undefined) continue;
      const list = issueMap.get(key);
      if (list) list.push(issue);
      else issueMap.set(key, [issue]);
    }
    const nodes = [...graph.nodes.values()].map((node) => ({ ...node, body: "" }));
    this.#graph = buildGraph(graph.refinoDir, nodes);
    this.#entries = new Map(nodes.map((node) => [node.id, { node, revision: INITIAL_REVISION }]));
    this.#issues = issueMap;
    this.#bodies.clear();
    this.#sortedIds = undefined;
    this.#revision = INITIAL_REVISION;
  }

  private putNode(node: RefinoNode): void {
    const existing = this.#entries.get(node.id);
    if (existing !== undefined) this.dropDependents(existing.node);
    const resident = { ...node, body: "" };
    this.#entries.set(node.id, { node: resident, revision: this.#revision });
    this.#graph.nodes.set(node.id, resident);
    this.addDependents(resident);
    this.dropIssues(node.id);
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
    this.dropIssues(id);
  }

  private addDependents(node: RefinoNode): void {
    if (node.type !== "constraint") return;
    for (const ground of node.grounds ?? []) {
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
    for (const ground of node.grounds ?? []) {
      const list = this.#graph.dependents.get(ground);
      if (list === undefined) continue;
      const filtered = list.filter((id) => id !== node.id);
      if (filtered.length === 0) this.#graph.dependents.delete(ground);
      else this.#graph.dependents.set(ground, filtered);
    }
  }

  /**
   * Incremental issue recheck scoped to the affected ids and their former
   * direct dependents: per-node grounds issues come from the engine's
   * `checkGroundsChange` (a cycle must pass through an affected node, and
   * dangling grounds only appear on nodes grounding on changed ids), the
   * confirmed format check complements it. Issues elsewhere in the graph are
   * unaffected by the change and stay cached.
   */
  private recheckIssues(affected: Iterable<string>): void {
    for (const id of affected) {
      this.dropIssues(id);
      const entry = this.#entries.get(id);
      if (entry === undefined) continue;
      const found: RefinoIssue[] = [];
      const { node } = entry;
      if (node.confirmed !== undefined && !isValidConfirmed(node.confirmed)) {
        found.push({
          code: "INVALID_CONFIRMED",
          message: `"confirmed" must be an RFC 3339 timestamp with an explicit UTC offset (Z or ±HH:MM), got "${node.confirmed}".`,
          file: node.file,
          nodeId: node.id,
        });
      }
      if (node.type === "constraint") {
        found.push(...checkGroundsChange(this.#graph, id, node.grounds ?? []));
      }
      if (found.length > 0) this.#issues.set(id, found);
    }
  }

  /** Drop every issue entry that can relate to the id, including file-keyed parse issues. */
  private dropIssues(id: string): void {
    this.#issues.delete(id);
    for (const file of candidateFiles(id)) this.#issues.delete(file);
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
  return ["constraint", "premise"].map(
    (type) => `nodes/${id.slice(0, 2)}/${id.slice(2)}.${type}.md` as const,
  );
}

/**
 * Change detection over the light fields the resident index tracks. Body
 * content is intentionally excluded (bodies are not resident; body-only
 * external edits surface on reload). Read bodies come in with the node but
 * are dropped when the entry is stored.
 */
function sameLightFields(previous: RefinoNode, read: RefinoNode): boolean {
  return (
    previous.type === read.type &&
    previous.file === read.file &&
    previous.summary === read.summary &&
    previous.rationale === read.rationale &&
    previous.confirmed === read.confirmed &&
    sameGrounds(previous.grounds, read.grounds)
  );
}

function sameGrounds(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  return a.every((id, i) => id === b[i]);
}
