import { derivedAnchors } from "./anchors.js";
import { diffAnchors } from "./context.js";
import { contentHash, SessionKnownSet, type KnownChange } from "./known-set.js";
import { orientationRoots } from "./inject-text.js";
import { HarnessSession } from "./session.js";
import { staleNodes, type StaleReport } from "./stale.js";
import { byId } from "./types.js";
import type { DeltaEvent } from "./types.js";
import { RefinoStore, type StoreChange, type StoreIssue } from "@refino/storage";
import { effectiveExploring } from "refino";
import type { RefinoNode } from "refino";

/**
 * One agent's DLG state over a `.refino/` directory: the storage Store's
 * resident projection, the anchor set the session was opened with, and
 * external-change syncing. Every applied change (own writes and external file
 * events alike) rebuilds the session here, so reads never see a stale graph
 * and anchors follow the graph (a node created mid-session joins the baseline
 * context, a deleted one leaves it).
 *
 * Node-only by necessity (the Store); exported through the
 * `@refino/harness/host` subpath so the platform-agnostic main entry stays
 * browser-safe.
 */

/** Callback for external (watcher-detected) syncs; must not throw. */
export type ExternalSyncListener = (outcome: SyncOutcome) => void;

export interface SyncOutcome {
  /** Anchor-set change events (empty when the baseline context is unchanged). */
  delta: DeltaEvent[];
  /** Ids of externally changed nodes — the update notification's change source. */
  changed: string[];
  /** Ids of externally deleted nodes. */
  deleted: string[];
  /** Direct dependents of the changed nodes, pending review. */
  pending: RefinoNode[];
}

export class RefinoWorkspace {
  #store: RefinoStore;
  #session: HarnessSession;
  /** Whether the anchors cover every node: false means the graph exceeded the budget. */
  #complete: boolean;
  /** What node information has reached the model. */
  #known: SessionKnownSet;
  #unsubscribe: () => void = () => {};

  private constructor(store: RefinoStore) {
    this.#store = store;
    this.#complete = false;
    this.#session = new HarnessSession(store.graph, []);
    // The known set snapshots the derived effective exploring status against
    // the live graph, so external mark flips (and their downstream effects)
    // surface as field-level diffs.
    this.#known = new SessionKnownSet((id) => effectiveExploring(store.graph, id));
  }

  /** Open the store (watching `nodes/`) and build the initial session. */
  static async open(
    refinoDir: string,
    onExternalSync?: ExternalSyncListener,
  ): Promise<RefinoWorkspace> {
    const store = RefinoStore.open(refinoDir, { watch: { debounceMs: 500 } });
    await store.ready();
    const workspace = new RefinoWorkspace(store);
    workspace.#rebuildSession();
    workspace.#seedKnown();
    workspace.#unsubscribe = store.onChange((change) => {
      const outcome = workspace.#absorb(change);
      if (change.origin !== "file") return; // own writes report through the write result
      // Push every file-origin change: with no context delta, the known-set
      // diff at fire time is the only thing left to say.
      onExternalSync?.(outcome);
    });
    return workspace;
  }

  get refinoDir(): string {
    return this.#store.refinoDir;
  }

  get store(): RefinoStore {
    return this.#store;
  }

  get graph() {
    return this.#store.graph;
  }

  /** Issues from the store (parse-level and structural). */
  get issues(): StoreIssue[] {
    return this.#store.issues();
  }

  /**
   * Whether the anchors cover every node: false means the graph exceeded the
   * auto-anchor budget and no baseline context was injected.
   */
  get anchorsComplete(): boolean {
    return this.#complete;
  }

  get session(): HarnessSession {
    return this.#session;
  }

  /** The session known set; tool cores harvest their results into it. */
  get known(): SessionKnownSet {
    return this.#known;
  }

  /**
   * Field-level changes of known nodes against the live graph; snapshots
   * re-sync in the same pass, so each drained diff is the increment since
   * the previous one. Async: body-seen nodes need the paged content hash to
   * separate real edits from mtime-only rewrites.
   */
  knownDiff(): Promise<KnownChange[]> {
    return this.#known.drainDiff(this.#store.graph, {
      revisionOf: (id) => this.#store.entry(id)?.revision,
      hashOf: async (id) => {
        const content = await this.content(id);
        return content === undefined ? undefined : contentHash(content);
      },
    });
  }

  /** Nodes overdue for review, measured against the given clock. */
  stale(nowMs: number, days?: number): StaleReport {
    return staleNodes(this.#store.graph, nowMs, days);
  }

  /** Id-level harvest for ids a tool result listed without node fields. */
  recordKnownIds(ids: readonly string[]): void {
    for (const id of ids) {
      const node = this.#store.graph.nodes.get(id);
      this.#known.recordIdOnly(id, node?.type, this.#store.entry(id)?.revision);
    }
  }

  /**
   * Absorb a successful own write into the known set: the written node is
   * recorded full (the model authored it) and its one-hop neighborhoods —
   * before and after the write — re-sync silently, so a later external sync
   * never reports the write back to its author. A deleted id drops its entry.
   */
  async absorbOwnWrite(
    id: string,
    prev?: { grounds: readonly string[]; children: readonly string[] },
  ): Promise<void> {
    const graph = this.#store.graph;
    const node = graph.nodes.get(id);
    if (node === undefined) {
      this.#known.drop(id);
      this.#known.reabsorb(graph, prev?.grounds ?? []);
      return;
    }
    const content = await this.content(id);
    this.#known.recordFull(
      node,
      this.#store.entry(id)?.revision,
      content === undefined ? contentHash({ body: "" }) : contentHash(content),
    );
    this.#known.reabsorb(graph, [id, ...(prev?.grounds ?? []), ...(prev?.children ?? [])]);
  }

  /** Paged node content on demand (body, rationale); the resident graph never holds it. */
  content(id: string) {
    return this.#store.content(id);
  }

  /** The pending-review set of an applied change, for tool results. */
  pendingOf(change: StoreChange | undefined): RefinoNode[] {
    if (change === undefined) return [];
    const pending = new Map<string, RefinoNode>();
    for (const id of change.affected) {
      const node = this.#store.graph.nodes.get(id);
      if (node !== undefined) pending.set(id, node);
    }
    return byId(pending.values());
  }

  /** Stop watching; the workspace stays readable but no longer syncs. */
  dispose(): void {
    this.#unsubscribe();
    this.#store.close();
  }

  /**
   * Rebuild the session over the store's current graph and derive the
   * anchor delta plus pending set of a change.
   */
  #absorb(change: StoreChange): SyncOutcome {
    const prevAnchors = this.#session.anchorIds;
    this.#rebuildSession();
    return {
      delta: diffAnchors(prevAnchors, this.#session.anchorIds),
      changed: change.changed,
      deleted: change.deleted,
      pending: this.pendingOf(change),
    };
  }

  #rebuildSession(): void {
    const graph = this.#store.graph;
    const { anchors, complete } = derivedAnchors(graph);
    this.#complete = complete;
    this.#session = new HarnessSession(graph, anchors);
  }

  /**
   * Seed the known set to match the baseline injection: under the auto-anchor
   * budget the anchor block covers every node; above it, the orientation's
   * root-decision set. Runs once at open, over the then-current graph — a change
   * between the host's baseline render and this point is fail-soft miss territory.
   */
  #seedKnown(): void {
    const graph = this.#store.graph;
    this.#known.seedSummaries(this.#complete ? [...graph.nodes.values()] : orientationRoots(graph));
  }
}
