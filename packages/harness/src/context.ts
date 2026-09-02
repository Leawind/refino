import type { Graph } from "refino";
import { frozenZone, validateContext } from "./boundary.js";
import type { AuthorizationContext, ContextBlock, DeltaEvent } from "./types.js";

/**
 * Render the authorization context as stable, identifiable blocks: one per
 * anchor, frozen constraint, frontier constraint and frontier refinement.
 * Blocks carry summaries only; full bodies are fetched on demand via tools.
 */
export function contextBlocks(graph: Graph, context: AuthorizationContext): ContextBlock[] {
  validateContext(graph, context);
  const blocks: ContextBlock[] = [];
  for (const id of context.anchors) {
    blocks.push({ id: `anchor:${id}`, kind: "anchor", nodeId: id, text: line(graph, id) });
  }
  for (const node of frozenZone(graph, context)) {
    blocks.push({
      id: `frozen:${node.id}`,
      kind: "frozen",
      nodeId: node.id,
      text: line(graph, node.id),
    });
  }
  const refinements = new Set<string>();
  for (const frontierId of context.frontier) {
    blocks.push({
      id: `frontier:${frontierId}`,
      kind: "frontier",
      nodeId: frontierId,
      text: line(graph, frontierId),
    });
    for (const id of forwardClosure(graph, frontierId)) {
      if (!context.frontier.includes(id)) refinements.add(id);
    }
  }
  for (const id of [...refinements].sort()) {
    blocks.push({ id: `refinement:${id}`, kind: "refinement", nodeId: id, text: line(graph, id) });
  }
  return blocks;
}

/**
 * Render the full context as markdown, grouped into a read-only frozen zone
 * and the authorized modification space below the frontier. Summaries only;
 * the model expands relevant nodes via tools (two-level injection).
 */
export function renderContext(graph: Graph, context: AuthorizationContext): string {
  const blocks = contextBlocks(graph, context);
  const section = (kind: ContextBlock["kind"], heading: string): string => {
    const lines = blocks.filter((b) => b.kind === kind).map((b) => b.text);
    return lines.length > 0 ? `${heading}\n${lines.join("\n")}` : "";
  };
  return [
    section("anchor", "## 作用域锚点"),
    section("frozen", "## 冻结区（只读依据，不可修改）"),
    section("frontier", "## 决策前沿（授权修改的边界节点）"),
    section("refinement", "## 前沿以内（授权继续细化的空间）"),
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/**
 * Incremental delta between two contexts: anchor/frontier membership changes
 * plus which constraints entered or left the frozen zone. Inject these events
 * instead of re-rendering the full context to keep the prompt-cache prefix
 * stable. `next` is validated against the graph.
 */
export function diffContext(
  graph: Graph,
  prev: AuthorizationContext,
  next: AuthorizationContext,
): DeltaEvent[] {
  validateContext(graph, next);
  const events: DeltaEvent[] = [];
  for (const id of next.anchors) {
    if (!prev.anchors.includes(id)) events.push({ type: "anchor_added", id });
  }
  for (const id of prev.anchors) {
    if (!next.anchors.includes(id)) events.push({ type: "anchor_removed", id });
  }
  for (const id of next.frontier) {
    if (!prev.frontier.includes(id)) events.push({ type: "frontier_added", id });
  }
  for (const id of prev.frontier) {
    if (!next.frontier.includes(id)) events.push({ type: "frontier_removed", id });
  }
  const prevFrozen = new Set(frozenZone(graph, prev).map((n) => n.id));
  const nextFrozen = new Set(frozenZone(graph, next).map((n) => n.id));
  for (const id of nextFrozen) {
    if (!prevFrozen.has(id)) events.push({ type: "frozen", id });
  }
  for (const id of prevFrozen) {
    if (!nextFrozen.has(id)) events.push({ type: "unfrozen", id });
  }
  return events;
}

function line(graph: Graph, id: string): string {
  const node = graph.nodes.get(id)!;
  const type = node.type === "premise" ? "premise" : "constraint";
  return `- ${node.id} [${type}] ${node.summary}`;
}

/** ids reachable from a seed by following `dependents` forwards, seed included. */
function forwardClosure(graph: Graph, seed: string): Set<string> {
  const seen = new Set<string>();
  const queue = [seed];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dependent of graph.dependents.get(id) ?? []) queue.push(dependent);
  }
  return seen;
}
