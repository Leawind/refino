import { IssueCode, type Graph, type RefinoIssue, type RefinoNode } from "./types.js";

/** RFC 3339 timestamp; the UTC offset (Z or ±HH:MM) is mandatory. */
const CONFIRMED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Whether the value is a valid premise `confirmed` timestamp. */
export function isValidConfirmed(value: string): boolean {
  return CONFIRMED_RE.test(value);
}

/**
 * Structural validation of a loaded graph:
 * 1. premise `confirmed` timestamps are RFC 3339 with an explicit UTC offset;
 * 2. every `grounds` reference resolves to an existing node;
 * 3. constraint -> constraint paths are acyclic.
 *
 * (Parse-level rules — unique ids, valid file-name ids, no `grounds` on
 * premises — are checked while loading; see `loadGraph`.)
 *
 * Cycle reporting is deterministic: each distinct cycle is reported once,
 * rotated so its smallest id comes first.
 */
export function validateGraph(graph: Graph): RefinoIssue[] {
  const issues: RefinoIssue[] = [];

  for (const node of sortedValues(graph.nodes)) {
    if (node.type === "premise") {
      if (node.confirmed !== undefined && !CONFIRMED_RE.test(node.confirmed)) {
        issues.push({
          code: IssueCode.InvalidConfirmed,
          message: `"confirmed" must be an RFC 3339 timestamp with an explicit UTC offset (Z or ±HH:MM), got "${node.confirmed}".`,
          file: node.file,
          nodeId: node.id,
        });
      }
      continue; // premises declare no grounds
    }
    for (const ground of node.grounds) {
      if (!graph.nodes.has(ground)) {
        issues.push({
          code: IssueCode.UnknownGround,
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

/**
 * Validate a prospective change of a node's grounds against the current
 * graph without mutating it. All write paths call this before persisting, so
 * graph-level grounds validation has a single source. Reports:
 *
 * - the target id does not exist (NODE_NOT_FOUND);
 * - grounds on a premise target (PREMISE_WITH_GROUNDS);
 * - repeated ground ids (INVALID_GROUNDS) — the storage format deduplicates
 *   grounds on load, so writing them would silently diverge from the file;
 * - grounds referencing nodes that do not exist (UNKNOWN_GROUND);
 * - cycles the change would close (CYCLE) — a ground that is the target
 *   itself or reaches it along existing grounds edges.
 *
 * Pre-existing issues elsewhere in the graph are not reported; callers run
 * `validateGraph` for the full picture. Ground entries are not shape-checked:
 * an entry that cannot be a node id simply does not resolve.
 */
export function checkGroundsChange(
  graph: Graph,
  id: string,
  newGrounds: readonly string[],
): RefinoIssue[] {
  const target = graph.nodes.get(id);
  if (!target) {
    return [{ code: IssueCode.NodeNotFound, message: `Node "${id}" not found`, nodeId: id }];
  }
  if (target.type === "premise" && newGrounds.length > 0) {
    return [
      {
        code: IssueCode.PremiseWithGrounds,
        message: `Premise "${id}" must not declare "grounds".`,
        file: target.file,
        nodeId: id,
      },
    ];
  }

  const issues: RefinoIssue[] = [];
  // Insertion-ordered counts: one INVALID_GROUNDS per repeated id, and each
  // distinct id checked (and cycled) exactly once, in declared order.
  const counts = new Map<string, number>();
  for (const ground of newGrounds) {
    counts.set(ground, (counts.get(ground) ?? 0) + 1);
  }
  for (const [ground, count] of counts) {
    if (count > 1) {
      issues.push({
        code: IssueCode.InvalidGrounds,
        message: `"grounds" lists node "${ground}" more than once.`,
        file: target.file,
        nodeId: id,
      });
    }
    if (!graph.nodes.has(ground)) {
      issues.push({
        code: IssueCode.UnknownGround,
        message: `"${id}" grounds on unknown node "${ground}".`,
        file: target.file,
        nodeId: id,
        groundId: ground,
      });
    }
  }
  issues.push(...closingCycles(graph, id, [...counts.keys()]));
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
    // Premises declare no grounds, so only constraints can continue a cycle.
    const grounds = node?.type === "constraint" ? node.grounds : [];
    for (const ground of grounds) {
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
            code: IssueCode.Cycle,
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

/**
 * Cycles the change would close: for each new ground, the first path found
 * back to the changed node along existing grounds edges, reported in
 * `validateGraph`'s closed shape. Edges out of the changed node are
 * irrelevant for reaching it, so the current graph can be searched as-is.
 * Premises declare no grounds, so paths through them end immediately.
 */
function closingCycles(graph: Graph, id: string, grounds: readonly string[]): RefinoIssue[] {
  const issues: RefinoIssue[] = [];
  for (const ground of grounds) {
    const path = groundsPath(graph, ground, id);
    if (path === undefined) continue;
    const cycle = [id, ...path];
    issues.push({
      code: IssueCode.Cycle,
      message: `Constraint cycle detected: ${cycle.join(" -> ")}.`,
      nodeId: id,
      cycle,
    });
  }
  return issues;
}

/**
 * First path from `start` to `target` along grounds edges, both ends
 * inclusive, or undefined. Neighbors are visited in declared grounds order,
 * so the result is deterministic; the visited set prunes branches that
 * cannot reach the target, keeping the search linear in the reachable
 * subgraph even when the graph already contains cycles.
 */
function groundsPath(graph: Graph, start: string, target: string): string[] | undefined {
  const path: string[] = [start];
  const visited = new Set<string>();
  const visit = (current: string): boolean => {
    if (current === target) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    const node = graph.nodes.get(current);
    const grounds = node?.type === "constraint" ? node.grounds : [];
    for (const ground of grounds) {
      path.push(ground);
      if (visit(ground)) return true;
      path.pop();
    }
    return false;
  };
  return visit(start) ? path : undefined;
}
