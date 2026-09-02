import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/graph.js";
import { parseNodeSource } from "../src/parser.js";
import { validateGraph } from "../src/validate.js";
import type { Graph, NodeType, RefinoNode } from "../src/index.js";
import { constraint, premise } from "@refino/testkit";

/** Build a graph in memory, mirroring the storage layout's dir-to-type rule. */
function graphOf(files: Record<string, string>): Graph {
  const nodes: RefinoNode[] = [];
  for (const [file, source] of Object.entries(files)) {
    const expectedType: NodeType = file.startsWith("premises/") ? "premise" : "constraint";
    const { node } = parseNodeSource(file, expectedType, source);
    if (node) nodes.push(node);
  }
  return buildGraph("/.refino", nodes);
}

describe("validateGraph", () => {
  it("accepts a diamond-shaped acyclic graph", () => {
    const graph = graphOf({
      "constraints/A1B2C3D4.md": constraint("A1B2C3D4", undefined),
      "constraints/B2C3D4E5.md": constraint("B2C3D4E5", ["A1B2C3D4"]),
      "constraints/C3D4E5F6.md": constraint("C3D4E5F6", ["A1B2C3D4"]),
      "constraints/D4E5F6G7.md": constraint("D4E5F6G7", ["B2C3D4E5", "C3D4E5F6"]),
    });
    expect(validateGraph(graph)).toEqual([]);
  });

  it("reports grounds on unknown nodes", () => {
    const graph = graphOf({
      "constraints/A1B2C3D4.md": constraint("A1B2C3D4", ["Z9Y8X7W6"]),
    });
    const issues = validateGraph(graph);
    expect(issues.map((i) => i.code)).toEqual(["UNKNOWN_GROUND"]);
    expect(issues[0]).toMatchObject({ nodeId: "A1B2C3D4", groundId: "Z9Y8X7W6" });
  });

  it("reports a two-node constraint cycle exactly once with a closed path", () => {
    const graph = graphOf({
      "constraints/A1B2C3D4.md": constraint("A1B2C3D4", ["B2C3D4E5"]),
      "constraints/B2C3D4E5.md": constraint("B2C3D4E5", ["A1B2C3D4"]),
    });
    const issues = validateGraph(graph);
    expect(issues.map((i) => i.code)).toEqual(["CYCLE"]);
    expect(issues[0]?.cycle).toEqual(["A1B2C3D4", "B2C3D4E5", "A1B2C3D4"]);
  });

  it("reports a self-loop as a cycle", () => {
    const graph = graphOf({
      "constraints/A1B2C3D4.md": constraint("A1B2C3D4", ["A1B2C3D4"]),
    });
    expect(validateGraph(graph).map((i) => i.code)).toEqual(["CYCLE"]);
  });

  it("reports a three-node cycle once regardless of the entry point", () => {
    const graph = graphOf({
      "constraints/A1B2C3D4.md": constraint("A1B2C3D4", ["B2C3D4E5"]),
      "constraints/B2C3D4E5.md": constraint("B2C3D4E5", ["C3D4E5F6"]),
      "constraints/C3D4E5F6.md": constraint("C3D4E5F6", ["A1B2C3D4"]),
      "constraints/D4E5F6G7.md": constraint("D4E5F6G7", ["A1B2C3D4"]),
    });
    const issues = validateGraph(graph);
    expect(issues.filter((i) => i.code === "CYCLE")).toHaveLength(1);
    expect(issues[0]?.cycle).toEqual(["A1B2C3D4", "B2C3D4E5", "C3D4E5F6", "A1B2C3D4"]);
  });

  it("does not mistake shared premises for cycles", () => {
    const graph = graphOf({
      "premises/1A2B3C4D.md": premise("1A2B3C4D"),
      "constraints/A1B2C3D4.md": constraint("A1B2C3D4", ["1A2B3C4D"]),
      "constraints/B2C3D4E5.md": constraint("B2C3D4E5", ["1A2B3C4D", "A1B2C3D4"]),
    });
    expect(validateGraph(graph)).toEqual([]);
  });

  it.each([
    ["missing the UTC offset", "2026-05-01T12:00:00"],
    ["a date-only value", "2026-05-01"],
    ["not a timestamp", "yesterday"],
  ])("reports INVALID_CONFIRMED for confirmed %s", (_label, confirmed) => {
    const graph = graphOf({
      "premises/1A2B3C4D.md": `---\nconfirmed: ${JSON.stringify(confirmed)}\n---\n\nBody.\n`,
    });
    const issues = validateGraph(graph);
    expect(issues.map((i) => i.code)).toEqual(["INVALID_CONFIRMED"]);
    expect(issues[0]?.nodeId).toBe("1A2B3C4D");
  });

  it.each(["2026-05-01T12:00:00Z", "2026-05-01T12:00:00+08:00", "2026-05-01T12:00:00.123-05:30"])(
    "accepts confirmed %s",
    (confirmed) => {
      const graph = graphOf({
        "premises/1A2B3C4D.md": `---\nconfirmed: ${JSON.stringify(confirmed)}\n---\n\nBody.\n`,
      });
      expect(validateGraph(graph)).toEqual([]);
      expect(graph.nodes.get("1A2B3C4D")?.confirmed).toBe(confirmed);
    },
  );
});
