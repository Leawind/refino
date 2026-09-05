import { join } from "node:path";
import {
  byId,
  defaultAuthorizationContext,
  frozenZone,
  pendingReview,
  validateContext,
  HarnessSession,
  type AuthorizationContext,
  type DeltaEvent,
} from "@refino/harness";
import {
  startNodeWatcher,
  loadGraph,
  readNode,
  type NodeContent,
  type NodeWatcher,
} from "@refino/storage";
import {
  getDependents,
  validateGraph,
  type Graph,
  type RefinoIssue,
  type RefinoNode,
} from "refino";

/**
 * One agent's CRG state over a `.refino` directory: the loaded graph under
 * the current authorization context, plus external-change syncing. The
 * context starts at the defaults (docs/design.md, dsh 插件落地形态); once a
 * host signs an explicit one (`signContext` — authorization console,
 * user commands, model-initiated confirmation), it is session state:
 * external syncs converge it instead of resetting — ids removed by the
 * reload drop out, surviving declarations are untouched. Write tools call
 * `sync` themselves and consume the outcome without injection.
 */
export interface SyncOutcome {
  /** Authorization-context change events (empty for context-preserving changes). */
  delta: DeltaEvent[];
  /** Direct dependents of the changed nodes, pending review (docs/crg.md 1.6). */
  pending: RefinoNode[];
}

/** Callback for external (watcher-detected) syncs; must not throw. */
export type ExternalSyncListener = (outcome: SyncOutcome) => void;

export class RefinoWorkspace {
  #refinoDir: string;
  #graph: Graph;
  #issues: RefinoIssue[];
  #session: HarnessSession;
  /** False until a host signs an explicit context; defaults apply until then. */
  #signed: boolean;
  /** Whether the default anchors cover every node (meaningful while unsigned). */
  #complete: boolean;
  /** Constraint ids of the frozen zone under the current context — the delta basis. */
  #zoneIds: Set<string>;
  #watcher: NodeWatcher | undefined;

  private constructor(refinoDir: string, graph: Graph, issues: RefinoIssue[]) {
    this.#refinoDir = refinoDir;
    this.#graph = graph;
    this.#issues = issues;
    const context = defaultAuthorizationContext(graph);
    this.#signed = false;
    this.#complete = context.complete;
    this.#session = new HarnessSession(graph, context.context);
    this.#zoneIds = constraintZoneIds(graph, context.context);
  }

  /** Load the graph and start watching `nodes/` for external changes. */
  static async open(
    refinoDir: string,
    onExternalSync?: ExternalSyncListener,
  ): Promise<RefinoWorkspace> {
    const loaded = await loadGraph(refinoDir);
    // loadGraph reports parse-level issues only; structural validation
    // (dangling grounds, cycles, confirmed timestamps) runs here so tools see
    // the same issue set the CLI does.
    const issues = [...loaded.issues, ...validateGraph(loaded.graph)];
    const workspace = new RefinoWorkspace(refinoDir, loaded.graph, issues);
    workspace.#watcher = startNodeWatcher(join(refinoDir, "nodes"), (ids) => {
      void workspace.sync(ids).then(
        (outcome) => {
          if (outcome.delta.length > 0 || outcome.pending.length > 0) {
            onExternalSync?.(outcome);
          }
        },
        () => {}, // a failed reload keeps the previous state; the next batch retries
      );
    });
    return workspace;
  }

  get refinoDir(): string {
    return this.#refinoDir;
  }

  get graph(): Graph {
    return this.#graph;
  }

  /** Paged node content on demand (body, rationale); the resident graph never holds it. */
  async content(id: string): Promise<NodeContent | undefined> {
    return (await readNode(this.#refinoDir, id)).content;
  }

  /** Issues from the most recent load (parse-level and structural). */
  get issues(): RefinoIssue[] {
    return this.#issues;
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

  /**
   * Sign an explicit authorization context: the frozen-zone selection of the
   * authorization console, a user command or a model-initiated confirmation.
   * Unknown ids or non-constraint frozen ids throw `HarnessError`. Returns
   * the delta events the host injects to keep the prompt-cache prefix stable.
   */
  signContext(context: AuthorizationContext): DeltaEvent[] {
    validateContext(this.#graph, context);
    const prevAnchors = new Set(this.#session.authorizationContext.anchors);
    const prevZone = this.#zoneIds;
    this.#signed = true;
    this.#session = new HarnessSession(this.#graph, context);
    this.#zoneIds = constraintZoneIds(this.#graph, context);
    return contextDelta(prevAnchors, prevZone, context, this.#zoneIds);
  }

  /**
   * Reload the graph, derive the next authorization context (defaults while
   * unsigned; the signed context converged otherwise — ids removed by the
   * reload drop out, so a foreign re-creation under the same id cannot smuggle
   * a different type into the frozen list), and report the context delta plus
   * the pending-review set for the changed nodes. Ids that disappeared
   * reload-side contribute their (old-graph) dependents to the pending set —
   * a deleted node's children review its removal.
   */
  async sync(changedIds: readonly string[]): Promise<SyncOutcome> {
    const prevAnchors = new Set(this.#session.authorizationContext.anchors);
    const prevZone = this.#zoneIds;
    const prevGraph = this.#graph;
    const { graph, issues } = await loadGraph(this.#refinoDir);
    this.#graph = graph;
    this.#issues = [...issues, ...validateGraph(graph)];

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
    const delta = contextDelta(prevAnchors, prevZone, next, this.#zoneIds);

    // Changed nodes that survive the reload map to their direct dependents
    // (docs/crg.md 1.6); nodes deleted in the reload contribute their
    // old-graph dependents directly — those are the pending set themselves.
    const changedKnown: string[] = [];
    const pendingIds = new Set<string>();
    for (const id of changedIds) {
      if (graph.nodes.has(id)) {
        changedKnown.push(id);
      } else if (prevGraph.nodes.has(id)) {
        for (const dependent of getDependents(prevGraph, id)) {
          pendingIds.add(dependent.node.id);
        }
      }
    }
    const pending = new Map<string, RefinoNode>();
    for (const node of changedKnown.length > 0 ? pendingReview(graph, changedKnown) : []) {
      pending.set(node.id, node);
    }
    for (const id of pendingIds) {
      const node = graph.nodes.get(id);
      if (node !== undefined) pending.set(id, node);
    }
    return { delta, pending: byId(pending.values()) };
  }

  /** Stop watching; the workspace stays readable but no longer syncs. */
  dispose(): void {
    this.#watcher?.close();
    this.#watcher = undefined;
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
