import { describe, expect, it } from "vitest";
import { loadGraph } from "../src/loader.js";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";

describe("loadGraph", () => {
  it("builds the graph and the dependents index from a .refino directory", async () => {
    const root = await createRefino({
      "premises/1A2B3C4D.md": premise("1A2B3C4D"),
      "constraints/A1B2C3D4.md": constraint("A1B2C3D4", undefined),
      "constraints/D4E5F6G7.md": constraint("D4E5F6G7", ["A1B2C3D4"]),
      "constraints/E5F6G7H8.md": constraint("E5F6G7H8", ["1A2B3C4D", "D4E5F6G7"]),
    });
    try {
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(issues).toEqual([]);
      expect([...graph.nodes.keys()].sort()).toEqual([
        "1A2B3C4D",
        "A1B2C3D4",
        "D4E5F6G7",
        "E5F6G7H8",
      ]);
      expect(graph.dependents.get("A1B2C3D4")).toEqual(["D4E5F6G7"]);
      expect(graph.dependents.get("D4E5F6G7")).toEqual(["E5F6G7H8"]);
      expect(graph.dependents.get("1A2B3C4D")).toEqual(["E5F6G7H8"]);
      expect(graph.nodes.get("E5F6G7H8")?.file).toBe("constraints/E5F6G7H8.md");
      expect(graph.nodes.get("1A2B3C4D")?.confirmed).toBeUndefined();
    } finally {
      await removeRefino(root);
    }
  });

  it("reports duplicate ids across directories and keeps the first node", async () => {
    const root = await createRefino({
      "premises/A1B2C3D4.md": premise("A1B2C3D4"),
      "constraints/A1B2C3D4.md": constraint("A1B2C3D4", undefined),
    });
    try {
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(graph.nodes.size).toBe(1);
      expect(issues.map((i) => i.code)).toEqual(["DUPLICATE_ID"]);
      expect(issues[0]?.nodeId).toBe("A1B2C3D4");
    } finally {
      await removeRefino(root);
    }
  });

  it("rejects file names that are not valid ids", async () => {
    const root = await createRefino({
      "constraints/C-001.md": constraint("C-001", undefined),
      "constraints/TOOLONG1.md": constraint("TOOLONG1", undefined),
    });
    try {
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(graph.nodes.size).toBe(0);
      expect(issues.map((i) => i.code)).toEqual(["INVALID_ID", "INVALID_ID"]);
    } finally {
      await removeRefino(root);
    }
  });

  it("ignores non-markdown files and nested directories", async () => {
    const root = await createRefino({
      "constraints/A1B2C3D4.md": constraint("A1B2C3D4", undefined),
      "constraints/notes.txt": "ignored",
      "constraints/nested/B2C3D4E5.md": constraint("B2C3D4E5", undefined),
    });
    try {
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(issues).toEqual([]);
      expect([...graph.nodes.keys()]).toEqual(["A1B2C3D4"]);
    } finally {
      await removeRefino(root);
    }
  });

  it("tolerates missing subdirectories", async () => {
    const root = await createRefino({
      "constraints/A1B2C3D4.md": constraint("A1B2C3D4", undefined),
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
