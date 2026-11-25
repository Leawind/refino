import {
  getAncestors,
  getDependents,
  getGrounds,
  queryGroups,
  requireNode,
  type Graph,
  type NodeWithDepth,
  type QueryGroup,
  type RefinoNode,
} from "refino";
import { contextBlocks } from "./context.js";
import { pendingReview } from "./pending.js";
import type { ContextBlock } from "./types.js";

/**
 * A task session over a loaded graph: the anchor set it started with, batch
 * queries with partial-success semantics, and the derived pending-review set.
 * Platform-agnostic; graph loading and node writes stay with the storage
 * adapter of the consuming package.
 */
export class HarnessSession {
  private readonly graph: Graph;
  private readonly anchors: readonly string[];

  constructor(graph: Graph, anchors: readonly string[]) {
    this.graph = graph;
    this.anchors = anchors;
  }

  /** The node ids loaded at task start. */
  get anchorIds(): readonly string[] {
    return this.anchors;
  }

  /** The anchors rendered as stable, identifiable blocks. */
  blocks(): ContextBlock[] {
    return contextBlocks(this.graph, this.anchors);
  }

  /** Decisions pending review after the given nodes changed. */
  pendingReview(changedIds: readonly string[]): RefinoNode[] {
    return pendingReview(this.graph, changedIds);
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
