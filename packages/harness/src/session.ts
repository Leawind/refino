import {
  getAncestors,
  getDependents,
  getGrounds,
  type Graph,
  type NodeWithDepth,
  type QueryGroup,
  type RefinoNode,
  queryGroups,
  requireNode,
} from "refino";
import { checkModification, validateContext } from "./boundary.js";
import { contextBlocks, diffContext } from "./context.js";
import { pendingReview } from "./pending.js";
import type { AuthorizationContext, ContextBlock, DeltaEvent, ModificationCheck } from "./types.js";

/**
 * Host adapter interface (docs/design.md, "harness 与工具插件的分工"). Tool
 * plugins (e.g. `@refino/dsh-plugin`) register the session's capabilities
 * with their host and deliver context updates through it; the host decides
 * how context blocks and delta events reach the model.
 */
export interface HarnessHost {
  /** Deliver context blocks and delta events to the model-facing channel. */
  emit(event: { blocks: ContextBlock[]; delta: DeltaEvent[] }): void;
}

/**
 * A task session over a loaded graph: query tools with batch, partial-success
 * semantics, modification space checks and incremental context updates.
 * Platform-agnostic; graph loading and node writes stay with the storage
 * adapter of the consuming package.
 */
export class HarnessSession {
  private graph: Graph;
  private context: AuthorizationContext;

  constructor(graph: Graph, context: AuthorizationContext) {
    validateContext(graph, context);
    this.graph = graph;
    this.context = context;
  }

  get authorizationContext(): AuthorizationContext {
    return this.context;
  }

  /**
   * Switch to a new authorization context and return the incremental delta
   * from the current one.
   */
  updateContext(next: AuthorizationContext): DeltaEvent[] {
    const delta = diffContext(this.graph, this.context, next);
    this.context = next;
    return delta;
  }

  /** Current context rendered as stable, identifiable blocks. */
  blocks(): ContextBlock[] {
    return contextBlocks(this.graph, this.context);
  }

  /** Constraints pending review after the given nodes changed. */
  pendingReview(changedIds: readonly string[]): RefinoNode[] {
    return pendingReview(this.graph, changedIds);
  }

  /** Check nodes against the modification space; unknown ids throw. */
  checkModification(ids: readonly string[]): ModificationCheck[] {
    return ids.map((id) => checkModification(this.graph, this.context, id));
  }

  listNodes(type?: RefinoNode["type"]): RefinoNode[] {
    const nodes = [...this.graph.nodes.values()];
    return (type ? nodes.filter((n) => n.type === type) : nodes).sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  }

  show(ids: readonly string[]): QueryGroup<RefinoNode>[] {
    return queryGroups(this.graph, ids, (graph, id) => [requireNode(graph, id)]);
  }

  grounds(ids: readonly string[]): QueryGroup<RefinoNode>[] {
    return queryGroups(this.graph, ids, getGrounds);
  }

  ancestors(ids: readonly string[]): QueryGroup<NodeWithDepth>[] {
    return queryGroups(this.graph, ids, getAncestors);
  }

  dependents(ids: readonly string[]): QueryGroup<NodeWithDepth>[] {
    return queryGroups(this.graph, ids, getDependents);
  }
}
