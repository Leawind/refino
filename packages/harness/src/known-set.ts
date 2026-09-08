import { createHash } from "node:crypto";
import type { Graph, RefinoNode } from "refino";

/**
 * The session known set (docs/design.md, 增量更新与缓存友好): what node
 * information has actually reached the model's context. The initial
 * injection seeds it and every tool result harvests into it; external-change
 * notifications are field-level diffs computed against it — nodes never seen
 * stay silent. Pure in-memory session state, fail-soft by design: it only
 * shapes notification quality, never read correctness (queries always hit
 * the store's current state).
 *
 * Host subpath only: the content hash needs node:crypto, so this module must
 * not leak into the browser-safe main entry (type-only imports are fine).
 */

/** What was delivered about one node; absent optional fields were never shown. */
export interface KnownEntry {
  /** Type at see time; a mismatch on diff means remove + re-create happened. */
  type?: RefinoNode["type"];
  /** Summary as delivered; undefined = id-level only (e.g. signing delta ids). */
  summary?: string;
  /** Direct grounds snapshot, recorded when the list itself was delivered. */
  grounds?: string[];
  /** Direct dependents snapshot, recorded when the list itself was delivered. */
  children?: string[];
  /** Body/rationale delivered (show) or authored (write tools). */
  bodySeen?: boolean;
  /** Store entry revision at see time; drift flags file-level changes. */
  revision?: number;
  /** Content hash at see time; separates real edits from mtime-only rewrites. */
  hash?: string;
}

export type KnownChange =
  | { id: string; kind: "deleted"; summary?: string }
  | { id: string; kind: "rebuilt"; fromType: string; toType: string }
  | { id: string; kind: "summary"; from: string; to: string }
  | { id: string; kind: "grounds"; added: string[]; removed: string[] }
  | { id: string; kind: "children"; added: string[]; removed: string[] }
  | { id: string; kind: "content" }
  | { id: string; kind: "touched" };

/** Hash the paged content fields; the exact-bytes rewrite guard's basis. */
export function contentHash(content: { body: string; rationale?: string }): string {
  return createHash("sha256")
    .update(`${content.body}\0${content.rationale ?? ""}`)
    .digest("hex");
}

/** Store reads the diff needs: revisions come from resident entries, hashes from paged content. */
export interface KnownDiffRead {
  revisionOf: (id: string) => number | undefined;
  hashOf: (id: string) => Promise<string | undefined>;
}

export class SessionKnownSet {
  #entries = new Map<string, KnownEntry>();
  #touched = false;

  /** Whether anything has been harvested or diffed since the last seeding. */
  get touched(): boolean {
    return this.#touched;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Reset to a summary-level seed (the baseline injection's node set). */
  seedSummaries(nodes: readonly RefinoNode[]): void {
    this.#entries = new Map();
    this.#touched = false;
    for (const node of nodes) {
      this.#entries.set(node.id, { type: node.type, summary: node.summary });
    }
  }

  /** Summary-level harvest (list/search/grounds/ancestors/dependents results). */
  recordSummaries(nodes: Iterable<RefinoNode>): void {
    for (const node of nodes) {
      const entry = this.#entry(node.id);
      entry.type = node.type;
      entry.summary = node.summary;
    }
    this.#touched = true;
  }

  /** Full harvest (show results, own writes): everything including content markers. */
  recordFull(node: RefinoNode, revision: number | undefined, hash: string | undefined): void {
    const entry = this.#entry(node.id);
    entry.type = node.type;
    entry.summary = node.summary;
    if (node.type === "constraint") entry.grounds = [...node.grounds];
    entry.bodySeen = true;
    entry.revision = revision;
    entry.hash = hash;
    this.#touched = true;
  }

  /** The queried node's grounds list became known (grounds tool, ancestors depth 1). */
  recordGroundsOf(id: string, grounds: readonly string[], type: RefinoNode["type"]): void {
    const entry = this.#entry(id);
    entry.type = type;
    entry.grounds = [...grounds];
    this.#touched = true;
  }

  /** The queried node's direct-dependents list became known (dependents tool). */
  recordChildrenOf(id: string, children: readonly string[], type: RefinoNode["type"]): void {
    const entry = this.#entry(id);
    entry.type = type;
    entry.children = [...children];
    this.#touched = true;
  }

  /** Id-level harvest (ids listed in signing/context results without fields). */
  recordIdOnly(
    id: string,
    type: RefinoNode["type"] | undefined,
    revision: number | undefined,
  ): void {
    const entry = this.#entry(id);
    if (entry.type === undefined && type !== undefined) entry.type = type;
    if (entry.revision === undefined && revision !== undefined) entry.revision = revision;
    this.#touched = true;
  }

  /**
   * Diff every known entry against the live graph, re-sync the snapshots,
   * and return the field-level changes. Computed at injection time (not per
   * store event): interleaved tool results have already refreshed snapshots,
   * so freshly re-fetched nodes collapse out of the notification.
   */
  async drainDiff(graph: Graph, read: KnownDiffRead): Promise<KnownChange[]> {
    const changes: KnownChange[] = [];
    for (const id of [...this.#entries.keys()].sort()) {
      const entry = this.#entries.get(id)!;
      const node = graph.nodes.get(id);
      if (node === undefined) {
        changes.push(
          entry.summary === undefined
            ? { id, kind: "deleted" }
            : { id, kind: "deleted", summary: entry.summary },
        );
        this.#entries.delete(id);
        continue;
      }
      if (entry.type !== undefined && entry.type !== node.type) {
        changes.push({ id, kind: "rebuilt", fromType: entry.type, toType: node.type });
        // The rebuilt node shares nothing with what the model saw.
        this.#entries.set(id, {});
        continue;
      }
      if (entry.summary !== undefined && entry.summary !== node.summary) {
        changes.push({ id, kind: "summary", from: entry.summary, to: node.summary });
        entry.summary = node.summary;
      }
      if (entry.grounds !== undefined && node.type === "constraint") {
        const diff = diffIds(entry.grounds, node.grounds);
        if (diff !== undefined) {
          changes.push({ id, kind: "grounds", ...diff });
          entry.grounds = [...node.grounds];
        }
      }
      if (entry.children !== undefined) {
        const diff = diffIds(entry.children, node.children);
        if (diff !== undefined) {
          changes.push({ id, kind: "children", ...diff });
          entry.children = [...node.children];
        }
      }
      let drifted = false;
      if (entry.revision !== undefined) {
        const revision = read.revisionOf(id);
        if (revision !== undefined && revision !== entry.revision) {
          drifted = true;
          entry.revision = revision;
          if (entry.bodySeen === true) {
            const hash = await read.hashOf(id);
            // An identical hash means an mtime-only rewrite: the delivered
            // content is still accurate, no content change to report.
            if (hash !== undefined && hash === entry.hash) continue;
            changes.push({ id, kind: "content" });
            entry.hash = hash;
          }
        }
      }
      // Id-level entries carry no fields to compare; the revision drift is
      // all the signal there is.
      if (
        drifted &&
        entry.summary === undefined &&
        entry.grounds === undefined &&
        entry.children === undefined &&
        entry.bodySeen !== true
      ) {
        changes.push({ id, kind: "touched" });
      }
    }
    this.#touched = true;
    return changes;
  }

  /**
   * Silently re-sync the snapshots of the given ids plus their one-hop
   * grounds/dependents, without reporting anything: used after own writes,
   * where the model authored the change and must not be notified about it.
   */
  reabsorb(graph: Graph, ids: readonly string[]): void {
    const closure = new Set<string>();
    for (const id of ids) {
      closure.add(id);
      const node = graph.nodes.get(id);
      if (node === undefined) continue;
      for (const ground of groundsOf(node)) closure.add(ground);
      for (const child of node.children) closure.add(child);
    }
    for (const id of closure) {
      const entry = this.#entries.get(id);
      if (entry === undefined) continue;
      const node = graph.nodes.get(id);
      if (node === undefined) {
        this.#entries.delete(id);
        continue;
      }
      if (entry.type !== undefined) entry.type = node.type;
      if (entry.summary !== undefined) entry.summary = node.summary;
      if (entry.grounds !== undefined && node.type === "constraint") {
        entry.grounds = [...node.grounds];
      }
      if (entry.children !== undefined) entry.children = [...node.children];
      // revision/hash stay: reabsorb runs over files the write did not touch.
    }
    this.#touched = true;
  }

  drop(id: string): void {
    this.#entries.delete(id);
    this.#touched = true;
  }

  #entry(id: string): KnownEntry {
    let entry = this.#entries.get(id);
    if (entry === undefined) {
      entry = {};
      this.#entries.set(id, entry);
    }
    return entry;
  }
}

function groundsOf(node: RefinoNode): readonly string[] {
  return node.type === "constraint" ? node.grounds : [];
}

/** Sorted-list membership diff; undefined when the lists are equal. */
function diffIds(
  prev: readonly string[],
  next: readonly string[],
): { added: string[]; removed: string[] } | undefined {
  const added = next.filter((id) => !prev.includes(id));
  const removed = prev.filter((id) => !next.includes(id));
  return added.length + removed.length > 0 ? { added, removed } : undefined;
}
