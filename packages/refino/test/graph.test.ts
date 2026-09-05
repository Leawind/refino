import { describe, expect, it } from "vitest";
import {
  addNode,
  buildGraph,
  removeNode,
  setGrounds,
  updateNode,
  RefinoError,
} from "../src/index.js";
import { IssueCode } from "refino";
import type { Graph, RefinoNode } from "../src/index.js";

function node(id: string, type: "premise" | "constraint", grounds?: string[]): RefinoNode {
  if (type === "premise") return { id, type, summary: "Fact." };
  return { id, type, summary: "Decision.", grounds: grounds ?? [] };
}

function graphOf(...nodes: RefinoNode[]): Graph {
  return buildGraph(nodes);
}

describe("buildGraph", () => {
  it("derives sorted, deduplicated children back-references", () => {
    const graph = graphOf(
      node("1A2B3C4D", "premise"),
      node("E5F6G7H8", "constraint", ["1A2B3C4D", "D4E5F6G7"]),
      node("D4E5F6G7", "constraint", ["1A2B3C4D"]),
    );
    expect(graph.nodes.get("1A2B3C4D")?.children).toEqual(["D4E5F6G7", "E5F6G7H8"]);
    expect(graph.nodes.get("E5F6G7H8")?.children).toEqual([]);
  });

  it("interns id strings across grounds and the node table", () => {
    const graph = graphOf(
      node("A1B2C3D4", "constraint"),
      node("B2C3D4E5", "constraint", ["A1B2C3D4"]),
    );
    const canonical = graph.nodes.get("A1B2C3D4")!.id;
    const grounds = graph.nodes.get("B2C3D4E5")!.grounds;
    expect(grounds[0]).toBe(canonical);
  });

  it("keeps grounds in declared order even when it differs from id order", () => {
    const graph = graphOf(
      node("D4E5F6G7", "constraint"),
      node("A1B2C3D4", "constraint", ["D4E5F6G7"]),
    );
    expect(graph.nodes.get("A1B2C3D4")?.grounds).toEqual(["D4E5F6G7"]);
  });
});

describe("addNode", () => {
  it("attaches a node and updates its parents' children", () => {
    const graph = graphOf(node("A1B2C3D4", "constraint"));
    addNode(graph, node("B2C3D4E5", "constraint", ["A1B2C3D4"]));
    expect(graph.nodes.get("B2C3D4E5")?.grounds).toEqual(["A1B2C3D4"]);
    expect(graph.nodes.get("A1B2C3D4")?.children).toEqual(["B2C3D4E5"]);
  });

  it("throws DUPLICATE_ID when the id is taken", () => {
    const graph = graphOf(node("A1B2C3D4", "constraint"));
    expect(() => addNode(graph, node("A1B2C3D4", "premise"))).toThrow(RefinoError);
    expect(() => addNode(graph, node("A1B2C3D4", "premise"))).toThrow(
      expect.objectContaining({ code: IssueCode.DuplicateId }) as unknown as Error,
    );
  });
});

describe("removeNode", () => {
  it("detaches the node and cleans its parents' children", () => {
    const graph = graphOf(
      node("A1B2C3D4", "constraint"),
      node("B2C3D4E5", "constraint", ["A1B2C3D4"]),
    );
    const removed = removeNode(graph, "B2C3D4E5");
    expect(removed.id).toBe("B2C3D4E5");
    expect(graph.nodes.has("B2C3D4E5")).toBe(false);
    expect(graph.nodes.get("A1B2C3D4")?.children).toEqual([]);
  });

  it("throws NODE_NOT_FOUND for an unknown id", () => {
    const graph = graphOf(node("A1B2C3D4", "constraint"));
    expect(() => removeNode(graph, "Z9Y8X7W6")).toThrow(
      expect.objectContaining({ code: IssueCode.NodeNotFound }) as unknown as Error,
    );
  });
});

describe("setGrounds", () => {
  it("replaces grounds and migrates the children back-references", () => {
    const graph = graphOf(
      node("A1B2C3D4", "constraint"),
      node("B2C3D4E5", "constraint"),
      node("C3D4E5F6", "constraint", ["A1B2C3D4"]),
    );
    setGrounds(graph, graph.nodes.get("C3D4E5F6")!, ["B2C3D4E5"]);
    expect(graph.nodes.get("C3D4E5F6")?.grounds).toEqual(["B2C3D4E5"]);
    expect(graph.nodes.get("A1B2C3D4")?.children).toEqual([]);
    expect(graph.nodes.get("B2C3D4E5")?.children).toEqual(["C3D4E5F6"]);
  });

  it("throws NODE_NOT_FOUND for unknown or premise targets", () => {
    const graph = graphOf(node("1A2B3C4D", "premise"));
    const premise = graph.nodes.get("1A2B3C4D")!;
    expect(() => setGrounds(graph, premise as never, [])).toThrow(RefinoError);
    expect(() =>
      setGrounds(graph, { id: "Z9Y8X7W6", type: "constraint", summary: "", grounds: [] }, []),
    ).toThrow(expect.objectContaining({ code: IssueCode.NodeNotFound }) as unknown as Error);
  });
});

describe("updateNode", () => {
  it("replaces the resident fields of a premise, including clearing confirmed", () => {
    const graph = graphOf(node("1A2B3C4D", "premise"));
    updateNode(graph, {
      id: "1A2B3C4D",
      type: "premise",
      summary: "New.",
      confirmed: 1757000000000,
    });
    expect(graph.nodes.get("1A2B3C4D")?.summary).toBe("New.");
    expect(graph.nodes.get("1A2B3C4D")?.confirmed).toBe(1757000000000);
    updateNode(graph, { id: "1A2B3C4D", type: "premise", summary: "Newer." });
    expect(graph.nodes.get("1A2B3C4D")?.confirmed).toBeUndefined();
  });

  it("replaces a constraint's grounds and keeps the children consistent", () => {
    const graph = graphOf(
      node("A1B2C3D4", "constraint"),
      node("B2C3D4E5", "constraint", ["A1B2C3D4"]),
    );
    updateNode(graph, { id: "B2C3D4E5", type: "constraint", summary: "Decision.", grounds: [] });
    expect(graph.nodes.get("B2C3D4E5")?.grounds).toEqual([]);
    expect(graph.nodes.get("A1B2C3D4")?.children).toEqual([]);
  });

  it("throws NODE_NOT_FOUND when the id does not resolve", () => {
    const graph = graphOf(node("A1B2C3D4", "constraint"));
    expect(() => updateNode(graph, node("Z9Y8X7W6", "premise"))).toThrow(RefinoError);
  });
});
