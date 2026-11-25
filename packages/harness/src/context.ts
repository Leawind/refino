import { effectiveExploring, type Graph } from "refino";
import type { ContextBlock, DeltaEvent } from "./types.js";

/** Complement statement closing every render: the exploring-marking protocol. */
export const EXPLORING_PROTOCOL =
  "标注 [探索] 者为试行承诺，可能被替换或撤销；未标注者为定案决策；试行期间的可复用知识应沉淀为前提。";

/**
 * Render the anchor set as stable, identifiable blocks. Blocks carry summaries
 * only; full bodies are fetched on demand via tools.
 */
export function contextBlocks(graph: Graph, anchors: readonly string[]): ContextBlock[] {
  const seen = new Set<string>();
  const blocks: ContextBlock[] = [];
  for (const id of anchors) {
    if (seen.has(id)) continue;
    const node = graph.nodes.get(id);
    if (node === undefined) continue;
    seen.add(id);
    blocks.push({ id: `anchor:${id}`, nodeId: id, text: line(graph, id) });
  }
  return blocks;
}

/**
 * Render the anchor set as markdown, closed by the protocol statement.
 * Summaries only (two-level injection); the model expands relevant nodes via
 * tools.
 */
export function renderContext(graph: Graph, anchors: readonly string[]): string {
  const blocks = contextBlocks(graph, anchors);
  return [
    blocks.length > 0 ? `## 作用域锚点\n${blocks.map((b) => b.text).join("\n")}` : "",
    EXPLORING_PROTOCOL,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/**
 * Incremental anchor change between two states. Anchors grow with the graph
 * (a node created mid-session joins the baseline context) and shrink when
 * nodes are deleted, so hosts inject these events instead of re-rendering the
 * full context.
 */
export function diffAnchors(prev: readonly string[], next: readonly string[]): DeltaEvent[] {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  const events: DeltaEvent[] = [];
  for (const id of next) {
    if (!prevSet.has(id)) events.push({ type: "anchor_added", id });
  }
  for (const id of prev) {
    if (!nextSet.has(id)) events.push({ type: "anchor_removed", id });
  }
  return events;
}

function line(graph: Graph, id: string): string {
  const node = graph.nodes.get(id)!;
  const type = node.type === "premise" ? "premise" : "decision";
  // Derived effective status: an unmarked decision downstream of an exploring
  // one annotates too.
  const exploring = node.type === "decision" && effectiveExploring(graph, id) ? " [探索]" : "";
  return `- ${node.id} [${type}]${exploring} ${node.summary}`;
}
