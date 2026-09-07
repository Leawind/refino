import type { NodeLite } from "../../types";

/**
 * Canonical structure of a displayed set: sorted ids plus sorted in-set
 * grounds edges. The canvas compares signatures across working-set changes
 * so a selection change that alters neither the node set nor the edges
 * keeps the live layout session instead of restarting (and wobbling) it.
 */
export function structureSignature(nodes: readonly NodeLite[]): string {
  const ids = nodes.map((node) => node.id);
  const idSet = new Set(ids);
  const edges = nodes
    .flatMap((node) =>
      (node.grounds ?? [])
        .filter((ground) => idSet.has(ground))
        .map((ground) => `${ground}>${node.id}`),
    )
    .sort();
  return `${[...ids].sort().join(",")}#${edges.join(",")}`;
}
