import type { Graph } from "refino";
import { frozenZone } from "@refino/harness";
import { effectiveContext, resolveAuthorization } from "@refino/harness/state";
import type { GlobalOptions } from "./shared.js";

/**
 * Frozen-status annotation for read commands: resolve the effective
 * authorization read-side and collect its zone. Every node rendering marks
 * frozen nodes so the model sees modifiability at each touchpoint — the
 * initial context no longer enumerates the zone (docs/design.md,
 * 上下文注入协议).
 */
export async function frozenIds(graph: Graph, opts: GlobalOptions): Promise<Set<string>> {
  const resolved = await resolveAuthorization(graph, opts);
  return new Set(frozenZone(graph, effectiveContext(graph, resolved)).map((n) => n.id));
}
