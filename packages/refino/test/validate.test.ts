import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/graph.js";
import { validateGraph } from "../src/validate.js";
import type { Graph, NodeType, RefinoNode } from "../src/index.js";

/** Test factory: build a node directly, bypassing any file parsing. */
function node(
  id: string,
  type: NodeType,
  opts: { grounds?: string[]; confirmed?: string } = {},
): RefinoNode {
  return {
    id,
    type,
    file: `${type}s/${id.slice(0, 2)}/${id.slice(2)}.md`,
    summary: "Body.",
    body: "Body.",
    ...(opts.grounds !== undefined && { grounds: opts.grounds }),
    ...(opts.confirmed !== undefined && { confirmed: opts.confirmed }),
  };
}

function graphOf(...nodes: RefinoNode[]): Graph {
  return buildGraph("/.refino", nodes);
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
    expect(issues.map((i) => i.code)).toEqual(["UNKNOWN_GROUND"]);
    expect(issues[0]).toMatchObject({ nodeId: "A1B2C3D4", groundId: "Z9Y8X7W6" });
  });

  it("reports a two-node constraint cycle exactly once with a closed path", () => {
    const graph = graphOf(
      node("A1B2C3D4", "constraint", { grounds: ["B2C3D4E5"] }),
      node("B2C3D4E5", "constraint", { grounds: ["A1B2C3D4"] }),
    );
    const issues = validateGraph(graph);
    expect(issues.map((i) => i.code)).toEqual(["CYCLE"]);
    expect(issues[0]?.cycle).toEqual(["A1B2C3D4", "B2C3D4E5", "A1B2C3D4"]);
  });

  it("reports a self-loop as a cycle", () => {
    const graph = graphOf(node("A1B2C3D4", "constraint", { grounds: ["A1B2C3D4"] }));
    expect(validateGraph(graph).map((i) => i.code)).toEqual(["CYCLE"]);
  });

  it("reports a three-node cycle once regardless of the entry point", () => {
    const graph = graphOf(
      node("A1B2C3D4", "constraint", { grounds: ["B2C3D4E5"] }),
      node("B2C3D4E5", "constraint", { grounds: ["C3D4E5F6"] }),
      node("C3D4E5F6", "constraint", { grounds: ["A1B2C3D4"] }),
      node("D4E5F6G7", "constraint", { grounds: ["A1B2C3D4"] }),
    );
    const issues = validateGraph(graph);
    expect(issues.filter((i) => i.code === "CYCLE")).toHaveLength(1);
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

  it.each([
    ["missing the UTC offset", "2026-05-01T12:00:00"],
    ["a date-only value", "2026-05-01"],
    ["not a timestamp", "yesterday"],
  ])("reports INVALID_CONFIRMED for confirmed %s", (_label, confirmed) => {
    const graph = graphOf(node("1A2B3C4D", "premise", { confirmed }));
    const issues = validateGraph(graph);
    expect(issues.map((i) => i.code)).toEqual(["INVALID_CONFIRMED"]);
    expect(issues[0]?.nodeId).toBe("1A2B3C4D");
  });

  it.each(["2026-05-01T12:00:00Z", "2026-05-01T12:00:00+08:00", "2026-05-01T12:00:00.123-05:30"])(
    "accepts confirmed %s",
    (confirmed) => {
      const graph = graphOf(node("1A2B3C4D", "premise", { confirmed }));
      expect(validateGraph(graph)).toEqual([]);
      expect(graph.nodes.get("1A2B3C4D")?.confirmed).toBe(confirmed);
    },
  );
});
