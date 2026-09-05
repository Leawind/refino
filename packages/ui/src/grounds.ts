import type { RefinoClient } from "./api";
import type { NodeLite } from "./types";

/**
 * Ground summaries for display surfaces (peek card, grounds lists). Ids are
 * rarely meaningful to users, so grounds render as their summaries; the lite
 * shapes arrive in one batched `POST /api/query/grounds` call per owner node
 * and summaries stay cached module-wide (peek and editors re-request the
 * same grounds constantly).
 */

const summaries = new Map<string, string>();

/** Cached summary of a node, or undefined when never seen. */
export function cachedSummary(id: string): string | undefined {
  return summaries.get(id);
}

function prime(lite: NodeLite): void {
  summaries.set(lite.id, lite.summary);
}

/**
 * Direct grounds of one node as lite shapes, in declared order. Dangling
 * grounds never resolve server-side and are simply absent; failures leave
 * the caller with an empty list (display falls back to raw ids).
 */
export async function fetchGroundLites(client: RefinoClient, ownerId: string): Promise<NodeLite[]> {
  try {
    const groups = await client.queryGrounds([ownerId]);
    const group = groups.find((entry) => entry.id === ownerId);
    if (group === undefined || "error" in group) return [];
    // Unlike the neighborhood queries, the grounds group's results are the
    // ground lites themselves, in declared order.
    const grounds = [...group.results];
    for (const lite of grounds) prime(lite);
    return grounds;
  } catch {
    return [];
  }
}
