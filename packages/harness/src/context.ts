import type { Graph } from "refino";
import { frozenZone, validateContext } from "./boundary.js";
import { byId } from "./types.js";
import type { AuthorizationContext, ContextBlock, DeltaEvent } from "./types.js";

/**
 * Render the authorization context as stable, identifiable blocks: one per
 * anchor, per premise (premises are injected by default, docs/crg.md 2.2)
 * and per frozen constraint. Blocks carry summaries only; full bodies are
 * fetched on demand via tools. Constraints outside the frozen zone are
 * intentionally not enumerated — they form the modification space by
 * complement. Premise members of the zone are covered by their premise
 * blocks and are not repeated.
 */
export function contextBlocks(graph: Graph, context: AuthorizationContext): ContextBlock[] {
  validateContext(graph, context);
  const blocks: ContextBlock[] = [];
  const anchors = new Set(context.anchors);
  for (const id of context.anchors) {
    blocks.push({ id: `anchor:${id}`, kind: "anchor", nodeId: id, text: line(graph, id) });
  }
  const premises = byId([...graph.nodes.values()].filter((n) => n.type === "premise"));
  for (const node of premises) {
    if (anchors.has(node.id)) continue;
    blocks.push({
      id: `premise:${node.id}`,
      kind: "premise",
      nodeId: node.id,
      text: line(graph, node.id),
    });
  }
  for (const node of frozenZone(graph, context)) {
    if (anchors.has(node.id) || node.type === "premise") continue;
    blocks.push({
      id: `frozen:${node.id}`,
      kind: "frozen",
      nodeId: node.id,
      text: line(graph, node.id),
    });
  }
  return blocks;
}

/**
 * Render the full context as markdown, grouped into anchors, premises and
 * the read-only frozen zone; the complement statement closes the render.
 * Summaries only; the model expands relevant nodes via tools (two-level
 * injection).
 */
export function renderContext(graph: Graph, context: AuthorizationContext): string {
  const blocks = contextBlocks(graph, context);
  const section = (kind: ContextBlock["kind"], heading: string): string => {
    const lines = blocks.filter((b) => b.kind === kind).map((b) => b.text);
    return lines.length > 0 ? `${heading}\n${lines.join("\n")}` : "";
  };
  return [
    section("anchor", "## 作用域锚点"),
    section("premise", "## 项目前提（客观事实）"),
    section("frozen", "## 冻结区（只读，不可修改）"),
    "冻结区以外的全部约束均属于修改空间，可以修改或继续细化。",
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/**
 * Incremental delta between two contexts: anchor membership changes plus the
 * per-node diff of the derived frozen zones — freezing one node emits events
 * for its ancestors too. Premise zone membership is not evented: premise
 * blocks are always injected, so it changes nothing model-visible. Inject
 * these events instead of re-rendering the full context to keep the
 * prompt-cache prefix stable. `next` is validated against the graph.
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
  const zoneIds = (context: AuthorizationContext): Set<string> =>
    new Set(
      frozenZone(graph, context)
        .filter((n) => n.type === "constraint")
        .map((n) => n.id),
    );
  const prevFrozen = zoneIds(prev);
  const nextFrozen = zoneIds(next);
  for (const id of nextFrozen) {
    if (!prevFrozen.has(id)) events.push({ type: "frozen_added", id });
  }
  for (const id of prevFrozen) {
    if (!nextFrozen.has(id)) events.push({ type: "frozen_removed", id });
  }
  return events;
}

function line(graph: Graph, id: string): string {
  const node = graph.nodes.get(id)!;
  const type = node.type === "premise" ? "premise" : "constraint";
  return `- ${node.id} [${type}] ${node.summary}`;
}
