import type { Graph } from "refino";
import { frozenZone, validateContext } from "./boundary.js";
import { byId } from "./types.js";
import type { AuthorizationContext, ContextBlock, DeltaEvent } from "./types.js";

/** Complement statement closing every render: the frozen-marking protocol. */
export const ZONE_PROTOCOL =
  "标注 [冻结] 者只读；未标注者及未列出者均属修改空间，可以修改或继续细化。";

/**
 * Render the authorization context as stable, identifiable blocks: one per
 * anchor and per premise (premises are injected by default, docs/crg.md 2.2).
 * The frozen zone is not enumerated — nodes inside it carry a `[冻结]` mark
 * on their line, and the protocol statement (ZONE_PROTOCOL) in the rendered
 * text tells the model that unmarked and unlisted nodes are modifiable.
 * Blocks carry summaries only; full bodies are fetched on demand via tools.
 */
export function contextBlocks(graph: Graph, context: AuthorizationContext): ContextBlock[] {
  validateContext(graph, context);
  const frozen = new Set(frozenZone(graph, context).map((n) => n.id));
  const blocks: ContextBlock[] = [];
  const anchors = new Set(context.anchors);
  for (const id of context.anchors) {
    blocks.push({ id: `anchor:${id}`, kind: "anchor", nodeId: id, text: line(graph, id, frozen) });
  }
  const premises = byId([...graph.nodes.values()].filter((n) => n.type === "premise"));
  for (const node of premises) {
    if (anchors.has(node.id)) continue;
    blocks.push({
      id: `premise:${node.id}`,
      kind: "premise",
      nodeId: node.id,
      text: line(graph, node.id, frozen),
    });
  }
  return blocks;
}

/**
 * Render the full context as markdown, grouped into anchors and premises;
 * the protocol statement closes the render. The frozen zone is not listed:
 * frozen nodes are marked `[冻结]` on their line (docs/design.md, 上下文注入
 * 协议). Summaries only; the model expands relevant nodes via tools
 * (two-level injection).
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
    ZONE_PROTOCOL,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/**
 * Injection size estimate for the signing preview: the block count and the
 * total character count the rendered context will occupy (blocks plus
 * section headings and the protocol statement). O(1) over the context; lets
 * the authorization console show what signing costs before it does.
 */
export function estimateContext(
  graph: Graph,
  context: AuthorizationContext,
): { blocks: number; chars: number } {
  const blocks = contextBlocks(graph, context);
  const kindHeadings: Record<ContextBlock["kind"], string> = {
    anchor: "## 作用域锚点",
    premise: "## 项目前提（客观事实）",
  };
  const usedKinds = new Set(blocks.map((b) => b.kind));
  let chars = blocks.reduce((sum, block) => sum + block.text.length + 1, 0);
  for (const kind of usedKinds) chars += kindHeadings[kind].length + 1;
  if (blocks.length > 0) chars += ZONE_PROTOCOL.length + 2;
  return { blocks: blocks.length, chars };
}

/**
 * Incremental delta between two contexts at signing granularity: anchor
 * membership plus the frozen frontier lists themselves. Ancestors are not
 * evented — the zone re-closes against the live graph on read, so expanding
 * the closure into per-ancestor events would only repeat what the protocol
 * already implies. Inject these events instead of re-rendering the full
 * context to keep the prompt-cache prefix stable. `next` is validated
 * against the graph.
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
  const prevFrozen = new Set(prev.frozen);
  for (const id of next.frozen) {
    if (!prevFrozen.has(id)) events.push({ type: "frozen_added", id });
  }
  const nextFrozen = new Set(next.frozen);
  for (const id of prev.frozen) {
    if (!nextFrozen.has(id)) events.push({ type: "frozen_removed", id });
  }
  return events;
}

function line(graph: Graph, id: string, frozen: Set<string>): string {
  const node = graph.nodes.get(id)!;
  const type = node.type === "premise" ? "premise" : "constraint";
  const mark = frozen.has(id) ? " [冻结]" : "";
  return `- ${node.id} [${type}]${mark} ${node.summary}`;
}
