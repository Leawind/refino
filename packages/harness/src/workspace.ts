import { authorizationContextOf, convergeAuthorization } from "./authorization.js";
import { defaultAuthorizationContext } from "./default.js";
import { frozenZone, validateContext } from "./boundary.js";
import { contentHash, SessionKnownSet, type KnownChange } from "./known-set.js";
import { orientationRoots } from "./inject-text.js";
import { HarnessSession } from "./session.js";
import { byId } from "./types.js";
import { orchestratorCredential, readAuthorizationDocument } from "./state.js";
import type { AuthorizationContext, DeltaEvent } from "./types.js";
import type { AuthorizationOrigin } from "./inject-text.js";
import { RefinoStore, type StoreChange, type StoreIssue } from "@refino/storage";
import type { Graph, RefinoNode } from "refino";

/**
 * One agent's CRG state over a `.refino/` directory: the storage Store's
 * resident projection under the current authorization context, plus
 * external-change syncing (docs/design.md, 存储层 Store / dsh 插件落地形态).
 * The context starts at the defaults; once a host signs an explicit one
 * (`signContext` — authorization console, user commands, model-initiated
 * confirmation), it is session state: store changes converge it instead of
 * resetting — ids removed by a change drop out, surviving declarations are
 * untouched. The projection and its consistency with the disk live in the
 * store; every applied change (own writes and external file events alike)
 * rebuilds the session here, so reads never see a stale graph.
 *
 * Node-only by necessity (the Store); exported through the
 * `@refino/harness/host` subpath so the platform-agnostic main entry stays
 * browser-safe (same policy as `@refino/harness/state`).
 */

/** Callback for external (watcher-detected) syncs; must not throw. */
export type ExternalSyncListener = (outcome: SyncOutcome) => void;

export interface SyncOutcome {
  /** Authorization-context change events (empty for context-preserving changes). */
  delta: DeltaEvent[];
  /** Ids of externally changed nodes — the update notification's change source. */
  changed: string[];
  /** Ids of externally deleted nodes. */
  deleted: string[];
  /** Direct dependents of the changed nodes, pending review (docs/crg.md 1.6). */
  pending: RefinoNode[];
}

/** How the effective authorization of a session was resolved. */
export interface ResolvedAuthorization {
  context: AuthorizationContext;
  origin: AuthorizationOrigin;
  /**
   * The error behind a fallback: set when an orchestrator credential is
   * present but unreadable or invalid, so defaults apply instead. Hosts log
   * it; the model-facing behavior is unchanged.
   */
  warning?: unknown;
}

/**
 * Resolve the authorization a session starts under (docs/design.md, dsh 插件
 * 落地形态): an orchestrator credential when the environment provides one,
 * the derived defaults otherwise. Hosts adopt the resolved context on their
 * workspace (signContext) when it is not the defaults.
 */
export async function resolveAuthorization(
  graph: Graph,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedAuthorization> {
  const fallback: ResolvedAuthorization = {
    context: defaultAuthorizationContext(graph).context,
    origin: { source: "default", signedAt: "" },
  };
  const credential = orchestratorCredential(env);
  if (credential === undefined) return fallback;
  try {
    const doc = convergeAuthorization(graph, await readAuthorizationDocument(credential));
    return {
      context: authorizationContextOf(graph, doc),
      origin: { source: "orchestrator", signedAt: doc.signedAt },
    };
  } catch (error) {
    return { ...fallback, warning: error };
  }
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
  /** What node information has reached the model (docs/design.md, 会话已知集). */
  #known: SessionKnownSet;
  /** False until the first signContext; the first signing re-seeds the known set. */
  #signedOnce = false;
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
    this.#known = new SessionKnownSet();
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
      // Push every file-origin change: with no anchors pending and no context
      // delta, the known-set diff at fire time is the only thing left to say.
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

  /**
   * Sign an explicit authorization context: the frozen-zone selection of the
   * authorization console, a user command or a model-initiated confirmation.
   * Unknown ids or non-constraint frozen ids throw `HarnessError`. Returns
   * the delta events the host injects to keep the prompt-cache prefix stable.
   * The first signing while the known set is still pristine (a host adopting
   * the resolved startup context before any tool ran) re-seeds it to the
   * signed baseline; any later signing harvests the delta's ids — the model
   * saw those ids in the injected events.
   */
  signContext(context: AuthorizationContext): DeltaEvent[] {
    validateContext(this.#store.graph, context);
    const prevAnchors = new Set(this.#session.authorizationContext.anchors);
    const prevZone = this.#zoneIds;
    this.#signed = true;
    this.#session = new HarnessSession(this.#store.graph, context);
    this.#zoneIds = constraintZoneIds(this.#store.graph, context);
    const delta = contextDelta(prevAnchors, prevZone, context, this.#zoneIds);
    if (this.#signedOnce || this.#known.touched) {
      this.recordKnownIds(delta.map((event) => event.id));
    } else {
      this.#seedSigned(context);
    }
    this.#signedOnce = true;
    return delta;
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
    return {
      delta,
      changed: change.changed,
      deleted: change.deleted,
      pending: this.pendingOf(change),
    };
  }

  #rebuildSession(): void {
    const graph = this.#store.graph;
    let next: AuthorizationContext;
    if (!this.#signed) {
      next = defaultAuthorizationContext(graph).context;
    } else {
      next = {
        anchors: this.#context.anchors.filter((id) => graph.nodes.has(id)),
        frozen: this.#context.frozen.filter((id) => graph.nodes.get(id)?.type === "constraint"),
      };
    }
    // A graph property, not a context property: anchors are runtime-derived
    // even when a host signed an explicit zone.
    this.#complete = defaultAuthorizationContext(graph).complete;
    this.#session = new HarnessSession(graph, next);
    this.#zoneIds = constraintZoneIds(graph, next);
  }

  /**
   * Seed the known set to match the baseline injection: under the auto-anchor
   * budget the anchor block covers every node; above it, the orientation's
   * root-constraint set. Runs once at open, over the then-current graph — a
   * change between the host's baseline render and this point is fail-soft
   * miss territory (docs/design.md, cc 插件落地形态 boundaries).
   */
  #seedKnown(): void {
    const graph = this.#store.graph;
    this.#known.seedSummaries(this.#complete ? [...graph.nodes.values()] : orientationRoots(graph));
  }

  /**
   * Re-seed to a signed context's baseline (anchors plus premises, the same
   * set the initial injection rendered). Only used by the first signing:
   * while untouched, the defaults seed still reflects nothing the model saw
   * under the signed context.
   */
  #seedSigned(context: AuthorizationContext): void {
    const graph = this.#store.graph;
    const ids = new Set(context.anchors);
    const nodes = [...graph.nodes.values()].filter(
      (node) => ids.has(node.id) || node.type === "premise",
    );
    this.#known.seedSummaries(nodes);
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
