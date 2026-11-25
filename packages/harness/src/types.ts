import type { Graph, RefinoNode } from "refino";

/**
 * A rendered context block with a stable identity. Hosts inject blocks into
 * the conversation; delta events reference blocks by id so an incremental
 * update stays unambiguous and prompt-cache friendly.
 */
export interface ContextBlock {
  /** Stable block identifier, e.g. `anchor:E5F6G7H8`. */
  id: string;
  nodeId: string;
  text: string;
}

/**
 * Incremental change of the anchor set. Hosts inject only these events
 * instead of re-rendering the full context, keeping the stable prefix intact
 * for model prompt caches.
 */
export type DeltaEvent = {
  type: "anchor_added" | "anchor_removed";
  id: string;
};

/**
 * Tool-name citations used by injected and rendered texts. A host that owns
 * its tool naming passes the names the model actually
 * calls (dsh native tools: `refino_show`); a host that surfaces tools under
 * its own scheme injects the full names into the model's tool list itself
 * (MCP hosts), so texts cite the bare short names — a hard-coded host prefix
 * would drift per host.
 */
export interface ToolRefs {
  search: string;
  show: string;
  grounds: string;
  stale: string;
}

/** Build refs from a host citation prefix: `refino_` (host-owned names) or `""` (bare short names). */
export function toolRefs(prefix: string): ToolRefs {
  return {
    search: `${prefix}search`,
    show: `${prefix}show`,
    grounds: `${prefix}grounds`,
    stale: `${prefix}stale`,
  };
}

/** Context node ids reference nodes that do not exist in the graph. */
export function unknownNodes(graph: Graph, ids: readonly string[]): string[] {
  return ids.filter((id) => !graph.nodes.has(id));
}

/** Sort nodes by id for deterministic output. */
export function byId(nodes: Iterable<RefinoNode>): RefinoNode[] {
  return [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
