import { join } from "node:path";
import {
  byId,
  defaultAuthorizationContext,
  frozenZone,
  pendingReview,
  HarnessSession,
  type AuthorizationContext,
  type DeltaEvent,
} from "@refino/harness";
import { startNodeWatcher, loadGraph, type NodeWatcher } from "@refino/storage";
import {
  getDependents,
  validateGraph,
  type Graph,
  type RefinoIssue,
  type RefinoNode,
} from "refino";

/**
 * One agent's CRG state over a `.refino` directory: the loaded graph under the
 * default authorization context (docs/design.md, dsh 插件落地形态 — v1 uses
 * defaults only), plus external-change syncing. External watcher batches
 * reload the graph, recompute the default context, and report context delta
 * events and the pending-review set; write tools call `sync` themselves and
 * consume the same outcome without injection.
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
  #complete: boolean;
  /** Constraint ids of the frozen zone under the current context — the delta basis. */
  #zoneIds: Set<string>;
  #watcher: NodeWatcher | undefined;

  private constructor(refinoDir: string, graph: Graph, issues: RefinoIssue[]) {
    this.#refinoDir = refinoDir;
    this.#graph = graph;
    this.#issues = issues;
    const context = defaultAuthorizationContext(graph);
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

  /** Issues from the most recent load (parse-level and structural). */
  get issues(): RefinoIssue[] {
    return this.#issues;
  }

  get authorizationContext(): AuthorizationContext {
    return this.#session.authorizationContext;
  }

  /**
   * Whether the default anchors cover every node: false means the graph
   * exceeded the auto-anchor budget and no initial context was injected.
   */
  get anchorsComplete(): boolean {
    return this.#complete;
  }

  get session(): HarnessSession {
    return this.#session;
  }

  /**
   * Reload the graph, recompute the default authorization context, and derive
   * the context delta plus the pending-review set for the changed nodes. Ids
   * that disappeared reload-side contribute their (old-graph) dependents to
   * the pending set — a deleted node's children review its removal.
   */
  async sync(changedIds: readonly string[]): Promise<SyncOutcome> {
    const prevAnchors = new Set(this.#session.authorizationContext.anchors);
    const prevZone = this.#zoneIds;
    const prevGraph = this.#graph;
    const { graph, issues } = await loadGraph(this.#refinoDir);
    const next = defaultAuthorizationContext(graph);
    this.#graph = graph;
    this.#issues = [...issues, ...validateGraph(graph)];
    this.#complete = next.complete;
    this.#session = new HarnessSession(graph, next.context);
    this.#zoneIds = constraintZoneIds(graph, next.context);

    const delta: DeltaEvent[] = [];
    for (const id of next.context.anchors) {
      if (!prevAnchors.has(id)) delta.push({ type: "anchor_added", id });
    }
    for (const id of prevAnchors) {
      if (!next.context.anchors.includes(id)) delta.push({ type: "anchor_removed", id });
    }
    for (const id of this.#zoneIds) {
      if (!prevZone.has(id)) delta.push({ type: "frozen_added", id });
    }
    for (const id of prevZone) {
      if (!this.#zoneIds.has(id)) delta.push({ type: "frozen_removed", id });
    }

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
}

function constraintZoneIds(graph: Graph, context: AuthorizationContext): Set<string> {
  return new Set(
    frozenZone(graph, context)
      .filter((node) => node.type === "constraint")
      .map((node) => node.id),
  );
}
