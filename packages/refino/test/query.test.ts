import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/graph.js";
import { getAncestors, getDependents, getGrounds, queryGroups, RefinoError } from "../src/index.js";
import type { Graph, NodeType, RefinoNode } from "../src/index.js";
import { IssueCode } from "refino";

/** Test factory: build a node directly, bypassing any file parsing. */
function node(id: string, type: NodeType, grounds?: string[]): RefinoNode {
  const base = {
    id,
    file: `${type}s/${id.slice(0, 2)}/${id.slice(2)}.md`,
    summary: "Body.",
    body: "Body.",
  };
  if (type === "premise") return { ...base, type };
  return { ...base, type, grounds: grounds ?? [] };
}

function graphOf(...nodes: RefinoNode[]): Graph {
  return buildGraph("/.refino", nodes);
}

/**
 * Fixture shape:
 *   1A2B3C4D ──┐
 *   A1B2C3D4 ──┴→ D4E5F6G7 → E5F6G7H8
 */
const graph = graphOf(
  node("1A2B3C4D", "premise"),
  node("A1B2C3D4", "constraint"),
  node("D4E5F6G7", "constraint", ["A1B2C3D4"]),
  node("E5F6G7H8", "constraint", ["1A2B3C4D", "D4E5F6G7"]),
);

function ids(results: ReadonlyArray<{ id: string; node?: { id: string } }>): string[] {
  return results.map((r) => r.node?.id ?? r.id);
}

describe("queries", () => {
  it("grounds are resolved in declared order", () => {
    expect(ids(getGrounds(graph, "E5F6G7H8"))).toEqual(["1A2B3C4D", "D4E5F6G7"]);
    expect(getGrounds(graph, "A1B2C3D4")).toEqual([]);
    expect(getGrounds(graph, "1A2B3C4D")).toEqual([]);
  });

  it("ancestors cover premises and upstream constraints with minimal depth", () => {
    const ancestors = getAncestors(graph, "E5F6G7H8");
    expect(ancestors.map((a) => [a.node.id, a.depth])).toEqual([
      ["1A2B3C4D", 1],
      ["D4E5F6G7", 1],
      ["A1B2C3D4", 2],
    ]);
  });

  it("ancestors of a premise are empty", () => {
    expect(getAncestors(graph, "1A2B3C4D")).toEqual([]);
  });

  it("maxDepth bounds the traversal without changing order", () => {
    expect(getAncestors(graph, "E5F6G7H8", { maxDepth: 1 }).map((a) => a.node.id)).toEqual([
      "1A2B3C4D",
      "D4E5F6G7",
    ]);
    expect(getDependents(graph, "A1B2C3D4", { maxDepth: 1 }).map((a) => a.node.id)).toEqual([
      "D4E5F6G7",
    ]);
    // Depth 0 includes nothing: the queried node itself is always excluded.
    expect(getAncestors(graph, "E5F6G7H8", { maxDepth: 0 })).toEqual([]);
    expect(getDependents(graph, "A1B2C3D4", { maxDepth: 0 })).toEqual([]);
    // The full closure still equals the unbounded default.
    expect(getAncestors(graph, "E5F6G7H8", { maxDepth: 99 })).toEqual(
      getAncestors(graph, "E5F6G7H8"),
    );
    expect(getDependents(graph, "A1B2C3D4", { maxDepth: 99 })).toEqual(
      getDependents(graph, "A1B2C3D4"),
    );
  });

  it("dependents are the transitive closure of downstream constraints", () => {
    expect(getDependents(graph, "A1B2C3D4").map((d) => [d.node.id, d.depth])).toEqual([
      ["D4E5F6G7", 1],
      ["E5F6G7H8", 2],
    ]);
    expect(getDependents(graph, "1A2B3C4D").map((d) => d.node.id)).toEqual(["E5F6G7H8"]);
    expect(getDependents(graph, "E5F6G7H8")).toEqual([]);
  });

  it("buildGraph indexes the dependents of premises and constraints", () => {
    expect(graph.dependents.get("1A2B3C4D")).toEqual(["E5F6G7H8"]);
    expect(graph.dependents.get("A1B2C3D4")).toEqual(["D4E5F6G7"]);
  });

  it("buildGraph leaves unknown grounds out of the dependents index", () => {
    const dangling = graphOf(node("A1B2C3D4", "constraint", ["Z9Y8X7W6"]));
    expect(dangling.dependents.has("Z9Y8X7W6")).toBe(false);
    expect(dangling.dependents.size).toBe(0);
  });

  it("queries on unknown nodes throw NODE_NOT_FOUND", () => {
    for (const query of [
      () => getGrounds(graph, "9M8N7P6Q"),
      () => getAncestors(graph, "9M8N7P6Q"),
      () => getDependents(graph, "9M8N7P6Q"),
    ]) {
      expect(query).toThrow(RefinoError);
      expect(query).toThrow(
        expect.objectContaining({ code: IssueCode.NodeNotFound }) as unknown as Error,
      );
    }
  });
});

describe("queryGroups", () => {
  it("groups results under each queried id", () => {
    const [group] = queryGroups(graph, ["D4E5F6G7"], getGrounds);
    if (!group || "error" in group) throw new Error("expected a result group");
    expect(group.results.map((n) => n.id)).toEqual(["A1B2C3D4"]);
  });

  it("yields a per-id error for missing ids without aborting the rest", () => {
    const groups = queryGroups(graph, ["9M8N7P6Q", "D4E5F6G7"], getAncestors);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({ id: "9M8N7P6Q", error: 'Node "9M8N7P6Q" not found' });
    if (!groups[1] || "error" in groups[1]) throw new Error("expected a result group");
    expect(groups[1].results.map((a) => a.node.id)).toEqual(["A1B2C3D4"]);
  });

  it("does not call select for missing ids", () => {
    let calls = 0;
    queryGroups(graph, ["9M8N7P6Q", "A1B2C3D4"], () => {
      calls++;
      return [];
    });
    expect(calls).toBe(1);
  });

  it("returns an empty list for an empty batch", () => {
    expect(queryGroups(graph, [], getGrounds)).toEqual([]);
  });
});
