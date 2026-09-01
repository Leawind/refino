import { describe, expect, it } from "vitest";
import { loadGraph } from "../src/loader.js";
import { validateGraph } from "../src/validate.js";
import { constraint, createRefino, premise, removeRefino } from "./helpers.js";

async function graphOf(files: Record<string, string>) {
  const root = await createRefino(files);
  const result = await loadGraph(`${root}/.refino`);
  return { root, ...result };
}

describe("validateGraph", () => {
  it("accepts a diamond-shaped acyclic graph", async () => {
    const { root, graph, issues } = await graphOf({
      "constraints/C-001.md": constraint("C-001", undefined),
      "constraints/C-002.md": constraint("C-002", ["C-001"]),
      "constraints/C-003.md": constraint("C-003", ["C-001"]),
      "constraints/C-004.md": constraint("C-004", ["C-002", "C-003"]),
    });
    try {
      expect(issues).toEqual([]);
      expect(validateGraph(graph)).toEqual([]);
    } finally {
      await removeRefino(root);
    }
  });

  it("reports grounds on unknown nodes", async () => {
    const { root, graph } = await graphOf({
      "constraints/C-001.md": constraint("C-001", ["P-999"]),
    });
    try {
      const issues = validateGraph(graph);
      expect(issues.map((i) => i.code)).toEqual(["UNKNOWN_GROUND"]);
      expect(issues[0]).toMatchObject({ nodeId: "C-001", groundId: "P-999" });
    } finally {
      await removeRefino(root);
    }
  });

  it("reports a two-node constraint cycle exactly once with a closed path", async () => {
    const { root, graph } = await graphOf({
      "constraints/C-001.md": constraint("C-001", ["C-002"]),
      "constraints/C-002.md": constraint("C-002", ["C-001"]),
    });
    try {
      const issues = validateGraph(graph);
      expect(issues.map((i) => i.code)).toEqual(["CYCLE"]);
      expect(issues[0]?.cycle).toEqual(["C-001", "C-002", "C-001"]);
    } finally {
      await removeRefino(root);
    }
  });

  it("reports a self-loop as a cycle", async () => {
    const { root, graph } = await graphOf({
      "constraints/C-001.md": constraint("C-001", ["C-001"]),
    });
    try {
      expect(validateGraph(graph).map((i) => i.code)).toEqual(["CYCLE"]);
    } finally {
      await removeRefino(root);
    }
  });

  it("reports a three-node cycle once regardless of the entry point", async () => {
    const { root, graph } = await graphOf({
      "constraints/C-001.md": constraint("C-001", ["C-002"]),
      "constraints/C-002.md": constraint("C-002", ["C-003"]),
      "constraints/C-003.md": constraint("C-003", ["C-001"]),
      "constraints/C-004.md": constraint("C-004", ["C-001"]),
    });
    try {
      const issues = validateGraph(graph);
      expect(issues.filter((i) => i.code === "CYCLE")).toHaveLength(1);
      expect(issues[0]?.cycle).toEqual(["C-001", "C-002", "C-003", "C-001"]);
    } finally {
      await removeRefino(root);
    }
  });

  it("does not mistake shared premises for cycles", async () => {
    const { root, graph, issues } = await graphOf({
      "premises/P-001.md": premise("P-001"),
      "constraints/C-001.md": constraint("C-001", ["P-001"]),
      "constraints/C-002.md": constraint("C-002", ["P-001", "C-001"]),
    });
    try {
      expect(issues).toEqual([]);
      expect(validateGraph(graph)).toEqual([]);
    } finally {
      await removeRefino(root);
    }
  });
});
