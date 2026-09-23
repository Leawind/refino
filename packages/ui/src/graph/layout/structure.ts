import type { NodeLite } from "../../types";

/**
 * Canonical structure of a displayed set: sorted ids split by node kind
 * (layouts place premises on their own display layers, so a same-id
 * rebuild as the other kind must restart the session), plus sorted in-set
 * grounds edges. The canvas compares signatures across working-set changes
 * so a selection change that alters neither the node set nor the edges
 * keeps the live layout session instead of restarting (and wobbling) it.
 */
export function structureSignature(nodes: readonly NodeLite[]): string {
  const decisions: string[] = [];
  const premises: string[] = [];
  for (const node of nodes) {
    (node.type === "premise" ? premises : decisions).push(node.id);
  }
  const idSet = new Set(nodes.map((node) => node.id));
  const edges = nodes
    .flatMap((node) =>
      (node.grounds ?? [])
        .filter((ground) => idSet.has(ground))
        .map((ground) => `${ground}>${node.id}`),
    )
    .sort();
  return `${decisions.sort().join(",")}#${premises.sort().join(",")}#${edges.join(",")}`;
}
