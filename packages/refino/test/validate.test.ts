import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/graph.js";
import { checkGroundsChange, validateGraph } from "../src/validate.js";
import type { ConstraintNode, Graph, NodeType, RefinoNode } from "../src/index.js";
import { IssueCode } from "refino";

/** Test factory: build a node directly, bypassing any storage parsing. */
function node(
  id: string,
  type: NodeType,
  opts: { grounds?: string[]; confirmed?: number } = {},
): RefinoNode {
  if (type === "premise") {
    return {
      id,
      type,
      summary: "Body.",
      ...(opts.confirmed !== undefined && { confirmed: opts.confirmed }),
    };
  }
  return { id, type, summary: "Body.", grounds: opts.grounds ?? [] };
}

function graphOf(...nodes: RefinoNode[]): Graph {
  return buildGraph(nodes);
}

/** The graph-attached constraint the grounds change targets. */
function target(graph: Graph, id: string): ConstraintNode {
  const n = graph.nodes.get(id);
  if (n === undefined || n.type !== "constraint") throw new Error(`no constraint "${id}"`);
  return n;
}

describe("validateGraph", () => {
  it("accepts a diamond-shaped acyclic graph", () => {
    const graph = graphOf(
      node("A1B2C3D4", "constraint"),
      node("B2C3D4E5", "constraint", { grounds: ["A1B2C3D4"] }),
      node("C3D4E5F6", "constraint", { grounds: ["A1B2C3D4"] }),
      node("D4E5F6G7", "constraint", { grounds: ["B2C3D4E5", "C3D4E5F6"] }),
    );
    expect(validateGraph(graph)).toEqual([]);
  });

  it("reports grounds on unknown nodes", () => {
    const graph = graphOf(node("A1B2C3D4", "constraint", { grounds: ["Z9Y8X7W6"] }));
    const issues = validateGraph(graph);
    expect(issues.map((i) => i.code)).toEqual([IssueCode.UnknownGround]);
    expect(issues[0]).toMatchObject({ nodeId: "A1B2C3D4", groundId: "Z9Y8X7W6" });
  });

  it("reports a two-node constraint cycle exactly once with a closed path", () => {
    const graph = graphOf(
      node("A1B2C3D4", "constraint", { grounds: ["B2C3D4E5"] }),
      node("B2C3D4E5", "constraint", { grounds: ["A1B2C3D4"] }),
    );
    const issues = validateGraph(graph);
    expect(issues.map((i) => i.code)).toEqual([IssueCode.Cycle]);
    expect(issues[0]?.cycle).toEqual(["A1B2C3D4", "B2C3D4E5", "A1B2C3D4"]);
  });

  it("reports a self-loop as a cycle", () => {
    const graph = graphOf(node("A1B2C3D4", "constraint", { grounds: ["A1B2C3D4"] }));
    expect(validateGraph(graph).map((i) => i.code)).toEqual([IssueCode.Cycle]);
  });

  it("reports a three-node cycle once regardless of the entry point", () => {
    const graph = graphOf(
      node("A1B2C3D4", "constraint", { grounds: ["B2C3D4E5"] }),
      node("B2C3D4E5", "constraint", { grounds: ["C3D4E5F6"] }),
      node("C3D4E5F6", "constraint", { grounds: ["A1B2C3D4"] }),
      node("D4E5F6G7", "constraint", { grounds: ["A1B2C3D4"] }),
    );
    const issues = validateGraph(graph);
    expect(issues.filter((i) => i.code === IssueCode.Cycle)).toHaveLength(1);
    expect(issues[0]?.cycle).toEqual(["A1B2C3D4", "B2C3D4E5", "C3D4E5F6", "A1B2C3D4"]);
  });

  it("does not mistake shared premises for cycles", () => {
    const graph = graphOf(
      node("1A2B3C4D", "premise"),
      node("A1B2C3D4", "constraint", { grounds: ["1A2B3C4D"] }),
      node("B2C3D4E5", "constraint", { grounds: ["1A2B3C4D", "A1B2C3D4"] }),
    );
    expect(validateGraph(graph)).toEqual([]);
  });
});

describe("checkGroundsChange", () => {
  it("accepts grounds that exist and do not close a cycle", () => {
    const graph = graphOf(
      node("1A2B3C4D", "premise"),
      node("A1B2C3D4", "constraint"),
      node("B2C3D4E5", "constraint", { grounds: ["1A2B3C4D"] }),
    );
    expect(checkGroundsChange(graph, target(graph, "A1B2C3D4"), ["1A2B3C4D", "B2C3D4E5"])).toEqual(
      [],
    );
  });

  it("accepts clearing grounds", () => {
    const graph = graphOf(
      node("A1B2C3D4", "constraint", { grounds: ["B2C3D4E5"] }),
      node("B2C3D4E5", "constraint"),
    );
    expect(checkGroundsChange(graph, target(graph, "A1B2C3D4"), [])).toEqual([]);
  });

  it("reports each repeated ground id once", () => {
    const graph = graphOf(node("A1B2C3D4", "constraint"), node("B2C3D4E5", "constraint"));
    const issues = checkGroundsChange(graph, target(graph, "A1B2C3D4"), [
      "B2C3D4E5",
      "B2C3D4E5",
      "B2C3D4E5",
    ]);
    expect(issues.map((i) => i.code)).toEqual([IssueCode.InvalidGrounds]);
    expect(issues[0]?.message).toContain('"B2C3D4E5"');
  });

  it("reports grounds on unknown nodes", () => {
    const graph = graphOf(node("A1B2C3D4", "constraint"));
    const issues = checkGroundsChange(graph, target(graph, "A1B2C3D4"), ["Z9Y8X7W6"]);
    expect(issues.map((i) => i.code)).toEqual([IssueCode.UnknownGround]);
    expect(issues[0]).toMatchObject({ nodeId: "A1B2C3D4", groundId: "Z9Y8X7W6" });
  });

  it("reports a self-referencing ground as a closed cycle", () => {
    const graph = graphOf(node("A1B2C3D4", "constraint"));
    const issues = checkGroundsChange(graph, target(graph, "A1B2C3D4"), ["A1B2C3D4"]);
    expect(issues.map((i) => i.code)).toEqual([IssueCode.Cycle]);
    expect(issues[0]?.cycle).toEqual(["A1B2C3D4", "A1B2C3D4"]);
  });

  it("reports a cycle closed through a direct ground", () => {
    const graph = graphOf(
      node("A1B2C3D4", "constraint"),
      node("B2C3D4E5", "constraint", { grounds: ["A1B2C3D4"] }),
    );
    const issues = checkGroundsChange(graph, target(graph, "A1B2C3D4"), ["B2C3D4E5"]);
    expect(issues.map((i) => i.code)).toEqual([IssueCode.Cycle]);
    expect(issues[0]?.cycle).toEqual(["A1B2C3D4", "B2C3D4E5", "A1B2C3D4"]);
  });

  it("reports a cycle closed through a transitive grounds path", () => {
    const graph = graphOf(
      node("A1B2C3D4", "constraint"),
      node("B2C3D4E5", "constraint", { grounds: ["A1B2C3D4"] }),
      node("C3D4E5F6", "constraint", { grounds: ["B2C3D4E5"] }),
      node("D4E5F6G7", "constraint", { grounds: ["C3D4E5F6"] }),
    );
    const issues = checkGroundsChange(graph, target(graph, "A1B2C3D4"), ["D4E5F6G7"]);
    expect(issues[0]?.cycle).toEqual(["A1B2C3D4", "D4E5F6G7", "C3D4E5F6", "B2C3D4E5", "A1B2C3D4"]);
  });

  it("follows declared grounds order when picking the reported path", () => {
    const graph = graphOf(
      node("A1B2C3D4", "constraint"),
      node("B2C3D4E5", "constraint", { grounds: ["C3D4E5F6", "D4E5F6G7"] }),
      node("C3D4E5F6", "constraint", { grounds: ["A1B2C3D4"] }),
      node("D4E5F6G7", "constraint", { grounds: ["A1B2C3D4"] }),
    );
    const issues = checkGroundsChange(graph, target(graph, "A1B2C3D4"), ["B2C3D4E5"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.cycle).toEqual(["A1B2C3D4", "B2C3D4E5", "C3D4E5F6", "A1B2C3D4"]);
  });

  it("reports one cycle per closing ground", () => {
    const graph = graphOf(
      node("A1B2C3D4", "constraint"),
      node("B2C3D4E5", "constraint", { grounds: ["A1B2C3D4"] }),
      node("C3D4E5F6", "constraint", { grounds: ["A1B2C3D4"] }),
    );
    const issues = checkGroundsChange(graph, target(graph, "A1B2C3D4"), ["B2C3D4E5", "C3D4E5F6"]);
    expect(issues.map((i) => i.cycle)).toEqual([
      ["A1B2C3D4", "B2C3D4E5", "A1B2C3D4"],
      ["A1B2C3D4", "C3D4E5F6", "A1B2C3D4"],
    ]);
  });

  it("does not report pre-existing cycles elsewhere in the graph", () => {
    const graph = graphOf(
      node("A1B2C3D4", "constraint"),
      node("B2C3D4E5", "constraint"),
      node("C3D4E5F6", "constraint", { grounds: ["D4E5F6G7"] }),
      node("D4E5F6G7", "constraint", { grounds: ["C3D4E5F6"] }),
    );
    expect(checkGroundsChange(graph, target(graph, "A1B2C3D4"), ["B2C3D4E5"])).toEqual([]);
  });

  it("leaves the graph untouched", () => {
    const graph = graphOf(
      node("A1B2C3D4", "constraint"),
      node("B2C3D4E5", "constraint", { grounds: ["A1B2C3D4"] }),
    );
    checkGroundsChange(graph, target(graph, "A1B2C3D4"), ["B2C3D4E5"]);
    // The constraint keeps its (empty) grounds list: the check never mutates.
    expect(graph.nodes.get("A1B2C3D4")?.grounds).toEqual([]);
    expect(graph.nodes.get("B2C3D4E5")?.grounds).toEqual(["A1B2C3D4"]);
  });
});
