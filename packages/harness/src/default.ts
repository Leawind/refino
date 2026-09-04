import type { Graph } from "refino";
import type { DefaultContext } from "./types.js";

/**
 * The default authorization context for a task without an explicit one
 * (docs/design.md, dsh plugin): the frozen list names all root constraints
 * (constraints without grounds) — closed over their ancestors, the frozen
 * zone is the roots with their grounds; anchors cover every node while the
 * graph has at most `maxAutoNodes` nodes — otherwise the context starts
 * without anchors, `complete` is false, and the host must obtain explicit
 * anchors before the initial injection. Premises are not listed here; they
 * are injected from the graph as a whole (docs/crg.md 2.2).
 */
export function defaultAuthorizationContext(graph: Graph, maxAutoNodes = 1024): DefaultContext {
  const complete = graph.nodes.size <= maxAutoNodes;
  const frozen = [...graph.nodes.values()]
    .filter((n) => n.type === "constraint" && (n.grounds?.length ?? 0) === 0)
    .map((n) => n.id)
    .sort();
  const anchors = complete ? [...graph.nodes.keys()].sort() : [];
  return { context: { anchors, frozen }, complete };
}
