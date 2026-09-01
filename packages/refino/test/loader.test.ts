import { describe, expect, it } from "vitest";
import { loadGraph } from "../src/loader.js";
import { constraint, createRefino, premise, removeRefino } from "./helpers.js";

describe("loadGraph", () => {
  it("builds the graph and the dependents index from a .refino directory", async () => {
    const root = await createRefino({
      "premises/P-003.md": premise("P-003"),
      "constraints/C-001.md": constraint("C-001", undefined),
      "constraints/C-007.md": constraint("C-007", ["C-001"]),
      "constraints/C-019.md": constraint("C-019", ["P-003", "C-007"]),
    });
    try {
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(issues).toEqual([]);
      expect([...graph.nodes.keys()].sort()).toEqual(["C-001", "C-007", "C-019", "P-003"]);
      expect(graph.dependents.get("C-001")).toEqual(["C-007"]);
      expect(graph.dependents.get("C-007")).toEqual(["C-019"]);
      expect(graph.dependents.get("P-003")).toEqual(["C-019"]);
      expect(graph.nodes.get("C-019")?.file).toBe("constraints/C-019.md");
    } finally {
      await removeRefino(root);
    }
  });

  it("reports duplicate ids across directories and keeps the first node", async () => {
    const root = await createRefino({
      "premises/C-001.md": premise("C-001"),
      "constraints/C-001.md": constraint("C-001", undefined),
    });
    try {
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(graph.nodes.size).toBe(1);
      expect(issues.map((i) => i.code)).toEqual(["DUPLICATE_ID"]);
      expect(issues[0]?.nodeId).toBe("C-001");
    } finally {
      await removeRefino(root);
    }
  });

  it("ignores non-markdown files and nested directories", async () => {
    const root = await createRefino({
      "constraints/C-001.md": constraint("C-001", undefined),
      "constraints/notes.txt": "ignored",
      "constraints/nested/C-002.md": constraint("C-002", undefined),
    });
    try {
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(issues).toEqual([]);
      expect([...graph.nodes.keys()]).toEqual(["C-001"]);
    } finally {
      await removeRefino(root);
    }
  });

  it("tolerates missing subdirectories", async () => {
    const root = await createRefino({
      "constraints/C-001.md": constraint("C-001", undefined),
    });
    try {
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(issues).toEqual([]);
      expect(graph.nodes.size).toBe(1);
    } finally {
      await removeRefino(root);
    }
  });

  it("throws REFINO_DIR_NOT_FOUND when .refino does not exist", async () => {
    const root = await createRefino({});
    try {
      await expect(loadGraph(`${root}/.refino`)).rejects.toMatchObject({
        name: "RefinoError",
        code: "REFINO_DIR_NOT_FOUND",
      });
    } finally {
      await removeRefino(root);
    }
  });
});
