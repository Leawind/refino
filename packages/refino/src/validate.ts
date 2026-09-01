import type { Graph, RefinoIssue, RefinoNode } from "./types.js";

/**
 * Structural validation of a loaded graph:
 * 1. every `grounds` reference resolves to an existing node;
 * 2. constraint -> constraint paths are acyclic.
 *
 * (Parse-level rules — unique ids, no `grounds` on premises, type/directory
 * agreement — are checked while loading; see `loadGraph`.)
 *
 * Cycle reporting is deterministic: each distinct cycle is reported once,
 * rotated so its smallest id comes first.
 */
export function validateGraph(graph: Graph): RefinoIssue[] {
  const issues: RefinoIssue[] = [];

  for (const node of sortedValues(graph.nodes)) {
    for (const ground of node.grounds ?? []) {
      if (!graph.nodes.has(ground)) {
        issues.push({
          code: "UNKNOWN_GROUND",
          message: `"${node.id}" grounds on unknown node "${ground}".`,
          file: node.file,
          nodeId: node.id,
          groundId: ground,
        });
      }
    }
  }

  issues.push(...findCycles(graph));
  return issues;
}

function findCycles(graph: Graph): RefinoIssue[] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const seen = new Set<string>();
  const issues: RefinoIssue[] = [];

  const visit = (id: string): void => {
    color.set(id, GRAY);
    stack.push(id);
    const node = graph.nodes.get(id);
    for (const ground of node?.grounds ?? []) {
      const target = graph.nodes.get(ground);
      if (!target || target.type !== "constraint") continue; // premises cannot take part in cycles
      const state = color.get(ground) ?? WHITE;
      if (state === WHITE) {
        visit(ground);
      } else if (state === GRAY) {
        const cycle = closeCycle(stack.slice(stack.indexOf(ground)));
        const key = canonicalCycleKey(cycle);
        if (!seen.has(key)) {
          seen.add(key);
          issues.push({
            code: "CYCLE",
            message: `Constraint cycle detected: ${cycle.join(" -> ")}.`,
            nodeId: id,
            cycle,
          });
        }
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };

  for (const node of sortedValues(graph.nodes)) {
    if (node.type !== "constraint") continue;
    if ((color.get(node.id) ?? WHITE) === WHITE) visit(node.id);
  }
  return issues;
}

/** A cycle found as an open path is closed by repeating its entry point. */
function closeCycle(open: string[]): string[] {
  const first = open[0];
  return first === undefined ? open : [...open, first];
}

function canonicalCycleKey(closed: string[]): string {
  const open = closed.slice(0, -1);
  let minIndex = 0;
  for (let i = 1; i < open.length; i++) {
    const candidate = open[i];
    const currentMin = open[minIndex];
    if (candidate !== undefined && currentMin !== undefined && candidate < currentMin) minIndex = i;
  }
  return [...open.slice(minIndex), ...open.slice(0, minIndex)].join(" -> ");
}

function sortedValues(nodes: Graph["nodes"]): RefinoNode[] {
  return [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
