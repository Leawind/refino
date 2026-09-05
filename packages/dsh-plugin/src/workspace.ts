import {
  byId,
  defaultAuthorizationContext,
  frozenZone,
  validateContext,
  HarnessSession,
  type AuthorizationContext,
  type DeltaEvent,
} from "@refino/harness";
import { RefinoStore, type StoreChange, type StoreIssue } from "@refino/storage";
import type { Graph, RefinoNode } from "refino";

/**
 * One agent's CRG state over a `.refino/` directory: the storage Store's
 * resident projection under the current authorization context, plus
 * external-change syncing. The context starts at the defaults
 * (docs/design.md, dsh 插件落地形态); once a host signs an explicit one
 * (`signContext` — authorization console, user commands, model-initiated
 * confirmation), it is session state: store changes converge it instead of
 * resetting — ids removed by a change drop out, surviving declarations are
 * untouched. The projection and its consistency with the disk live in the
 * store; every applied change (own writes and external file events alike)
 * rebuilds the session here, so reads never see a stale graph.
 */

/** Callback for external (watcher-detected) syncs; must not throw. */
export type ExternalSyncListener = (outcome: SyncOutcome) => void;

export interface SyncOutcome {
  /** Authorization-context change events (empty for context-preserving changes). */
  delta: DeltaEvent[];
  /** Direct dependents of the changed nodes, pending review (docs/crg.md 1.6). */
  pending: RefinoNode[];
}

export class RefinoWorkspace {
  #store: RefinoStore;
  #session: HarnessSession;
  /** False until a host signs an explicit context; defaults apply until then. */
  #signed: boolean;
  /** Whether the default anchors cover every node (meaningful while unsigned). */
  #complete: boolean;
  /** Constraint ids of the frozen zone under the current context — the delta basis. */
  #zoneIds: Set<string>;
  #unsubscribe: () => void = () => {};

  private constructor(store: RefinoStore) {
    this.#store = store;
    this.#signed = false;
    this.#complete = false;
    this.#session = new HarnessSession(
      store.graph,
      defaultAuthorizationContext(store.graph).context,
    );
    this.#zoneIds = constraintZoneIds(store.graph, this.#session.authorizationContext);
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
    workspace.#unsubscribe = store.onChange((change) => {
      let outcome;
      try {
        outcome = workspace.#absorb(change);
      } catch (error) {
        console.log("ABSORB FAILED:", error);
        throw error;
      }
      if (change.origin !== "file") return; // own writes report through the write result
      if (outcome.delta.length > 0 || outcome.pending.length > 0) onExternalSync?.(outcome);
    });
    return workspace;
  }

  get refinoDir(): string {
    return this.#store.refinoDir;
  }

  get store(): RefinoStore {
    return this.#store;
  }

  get graph(): Graph {
    return this.#store.graph;
  }

  /** Issues from the store (parse-level and structural). */
  get issues(): StoreIssue[] {
    return this.#store.issues();
  }

  get authorizationContext(): AuthorizationContext {
    return this.#session.authorizationContext;
  }

  /** Whether an explicit context has been signed over the defaults. */
  get contextSigned(): boolean {
    return this.#signed;
  }

  /**
   * Whether the default anchors cover every node: false means the graph
   * exceeded the auto-anchor budget and no initial context was injected.
   * Only meaningful while the context is unsigned.
   */
  get anchorsComplete(): boolean {
    return this.#complete;
  }

  get session(): HarnessSession {
    return this.#session;
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

  /**
   * Sign an explicit authorization context: the frozen-zone selection of the
   * authorization console, a user command or a model-initiated confirmation.
   * Unknown ids or non-constraint frozen ids throw `HarnessError`. Returns
   * the delta events the host injects to keep the prompt-cache prefix stable.
   */
  signContext(context: AuthorizationContext): DeltaEvent[] {
    validateContext(this.#store.graph, context);
    const prevAnchors = new Set(this.#session.authorizationContext.anchors);
    const prevZone = this.#zoneIds;
    this.#signed = true;
    this.#session = new HarnessSession(this.#store.graph, context);
    this.#zoneIds = constraintZoneIds(this.#store.graph, context);
    return contextDelta(prevAnchors, prevZone, context, this.#zoneIds);
  }

  /** Stop watching; the workspace stays readable but no longer syncs. */
  dispose(): void {
    this.#unsubscribe();
    this.#store.close();
  }

  /**
   * Rebuild the session over the store's current graph and derive the
   * context delta plus pending set of a change. The signed context converges
   * (ids removed by the change drop out, so a foreign re-creation under the
   * same id cannot smuggle a different type into the frozen list); unsigned,
   * the defaults re-derive.
   */
  #absorb(change: StoreChange): SyncOutcome {
    const prevAnchors = new Set(this.#session.authorizationContext.anchors);
    const prevZone = this.#zoneIds;
    this.#rebuildSession();
    const delta = contextDelta(prevAnchors, prevZone, this.#context, this.#zoneIds);
    return { delta, pending: this.pendingOf(change) };
  }

  #rebuildSession(): void {
    const graph = this.#store.graph;
    let next: AuthorizationContext;
    if (!this.#signed) {
      const context = defaultAuthorizationContext(graph);
      this.#complete = context.complete;
      next = context.context;
    } else {
      next = {
        anchors: this.#context.anchors.filter((id) => graph.nodes.has(id)),
        frozen: this.#context.frozen.filter((id) => graph.nodes.get(id)?.type === "constraint"),
      };
    }
    this.#session = new HarnessSession(graph, next);
    this.#zoneIds = constraintZoneIds(graph, next);
  }

  /** The current context, for convergence reads (kept private to the class). */
  get #context(): AuthorizationContext {
    return this.#session.authorizationContext;
  }
}

/** Anchor and derived frozen-zone delta between two context states. */
function contextDelta(
  prevAnchors: ReadonlySet<string>,
  prevZone: ReadonlySet<string>,
  next: AuthorizationContext,
  nextZone: ReadonlySet<string>,
): DeltaEvent[] {
  const delta: DeltaEvent[] = [];
  for (const id of next.anchors) {
    if (!prevAnchors.has(id)) delta.push({ type: "anchor_added", id });
  }
  for (const id of prevAnchors) {
    if (!next.anchors.includes(id)) delta.push({ type: "anchor_removed", id });
  }
  for (const id of nextZone) {
    if (!prevZone.has(id)) delta.push({ type: "frozen_added", id });
  }
  for (const id of prevZone) {
    if (!nextZone.has(id)) delta.push({ type: "frozen_removed", id });
  }
  return delta;
}

function constraintZoneIds(graph: Graph, context: AuthorizationContext): Set<string> {
  return new Set(
    frozenZone(graph, context)
      .filter((node) => node.type === "constraint")
      .map((node) => node.id),
  );
}
