import type { Graph, RefinoNode } from "refino";

/**
 * Review-maintenance query: which nodes are overdue for review. A decision's
 * age comes from its `reviewed` time, a premise's from its `confirmed` time;
 * a node carrying no such timestamp has never been reviewed. Node content
 * stores no dates — these attributes are the only time axis the graph has.
 *
 * Pure projection over the resident fields, so it costs no content reads.
 */

/** Default overdue threshold in days. */
export const DEFAULT_STALE_DAYS = 90;

export interface StaleNode {
  id: string;
  type: RefinoNode["type"];
  summary: string;
  /** Days since the last review; absent when the node was never reviewed. */
  age_days?: number;
}

export interface StaleReport {
  days: number;
  /** Nodes last reviewed more than `days` days ago, oldest first. */
  overdue: StaleNode[];
  /** Nodes that carry no review timestamp at all, by id. */
  never: StaleNode[];
}

export function staleNodes(graph: Graph, nowMs: number, days = DEFAULT_STALE_DAYS): StaleReport {
  const overdue: StaleNode[] = [];
  const never: StaleNode[] = [];
  for (const node of graph.nodes.values()) {
    const reviewedAt = node.type === "decision" ? node.reviewed : node.confirmed;
    if (reviewedAt === undefined) {
      never.push({ id: node.id, type: node.type, summary: node.summary });
      continue;
    }
    const ageDays = Math.floor((nowMs - reviewedAt) / 86_400_000);
    if (ageDays > days) {
      overdue.push({ id: node.id, type: node.type, summary: node.summary, age_days: ageDays });
    }
  }
  overdue.sort((a, b) => (b.age_days ?? 0) - (a.age_days ?? 0) || compareId(a.id, b.id));
  never.sort((a, b) => compareId(a.id, b.id));
  return { days, overdue, never };
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
