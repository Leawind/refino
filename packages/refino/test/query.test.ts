import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/graph.js";
import { getAncestors, getDependents, getGrounds, queryGroups, RefinoError } from "../src/index.js";
import type { Graph, NodeType, RefinoNode } from "../src/index.js";
import { IssueCode } from "refino";

/** Test factory: build a node directly, bypassing any storage parsing. */
function node(id: string, type: NodeType, grounds?: string[]): RefinoNode {
  if (type === "premise") return { id, type, summary: "Body." };
  return { id, type, summary: "Body.", grounds: grounds ?? [] };
}

function graphOf(...nodes: RefinoNode[]): Graph {
  return buildGraph(nodes);
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

  it("buildGraph derives the children back-references of premises and constraints", () => {
    expect(graph.nodes.get("1A2B3C4D")?.children).toEqual(["E5F6G7H8"]);
    expect(graph.nodes.get("A1B2C3D4")?.children).toEqual(["D4E5F6G7"]);
    expect(graph.nodes.get("D4E5F6G7")?.children).toEqual(["E5F6G7H8"]);
    expect(graph.nodes.get("E5F6G7H8")?.children).toEqual([]);
  });

  it("buildGraph leaves unknown grounds out of the children index", () => {
    const dangling = graphOf(node("A1B2C3D4", "constraint", ["Z9Y8X7W6"]));
    expect(dangling.nodes.get("Z9Y8X7W6")).toBeUndefined();
    expect(dangling.nodes.get("A1B2C3D4")?.children).toEqual([]);
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
