import { describe, expect, it } from "vitest";
import { loadGraph } from "../src/loader.js";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";

describe("loadGraph", () => {
  it("builds the graph and the dependents index from a .refino directory", async () => {
    const root = await createRefino({
      "premises/1A/2B3C4D.md": premise("1A2B3C4D"),
      "constraints/A1/B2C3D4.md": constraint("A1B2C3D4", undefined),
      "constraints/D4/E5F6G7.md": constraint("D4E5F6G7", ["A1B2C3D4"]),
      "constraints/E5/F6G7H8.md": constraint("E5F6G7H8", ["1A2B3C4D", "D4E5F6G7"]),
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
      expect(graph.nodes.get("E5F6G7H8")?.file).toBe("constraints/E5/F6G7H8.md");
      expect(graph.nodes.get("1A2B3C4D")?.confirmed).toBeUndefined();
    } finally {
      await removeRefino(root);
    }
  });

  it("derives the id from shard directory and file name", async () => {
    const root = await createRefino({
      "constraints/01/9ABCDE.md": constraint("019ABCDE", undefined),
    });
    try {
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(issues).toEqual([]);
      expect(graph.nodes.get("019ABCDE")).toMatchObject({
        id: "019ABCDE",
        file: "constraints/01/9ABCDE.md",
      });
    } finally {
      await removeRefino(root);
    }
  });

  it("reports duplicate ids across directories and keeps the first node", async () => {
    const root = await createRefino({
      "premises/A1/B2C3D4.md": premise("A1B2C3D4"),
      "constraints/A1/B2C3D4.md": constraint("A1B2C3D4", undefined),
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

  it("reports stray top-level node files as INVALID_NODE_PATH", async () => {
    const root = await createRefino({
      "constraints/A1B2C3D4.md": constraint("A1B2C3D4", undefined),
    });
    try {
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(graph.nodes.size).toBe(0);
      expect(issues.map((i) => i.code)).toEqual(["INVALID_NODE_PATH"]);
      expect(issues[0]?.file).toBe("constraints/A1B2C3D4.md");
      expect(issues[0]?.message).toContain("<type>/<shard>/<id>.md");
    } finally {
      await removeRefino(root);
    }
  });

  it("rejects shard file names that are not 6 valid characters", async () => {
    const root = await createRefino({
      "constraints/A1/C-001.md": constraint("A1C-001", undefined),
      "constraints/A1/TOOLON.md": constraint("A1TOOLON", undefined),
    });
    try {
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(graph.nodes.size).toBe(0);
      expect(issues.map((i) => i.code)).toEqual(["INVALID_ID", "INVALID_ID"]);
    } finally {
      await removeRefino(root);
    }
  });

  it("silently ignores non-shard directories and non-markdown files", async () => {
    const root = await createRefino({
      "constraints/A1/B2C3D4.md": constraint("A1B2C3D4", undefined),
      "constraints/notes/keep.md": "ignored",
      "constraints/TOOLONG1/ignored.md": "ignored",
      "constraints/A1/notes.txt": "ignored",
      "constraints/A1/nested/B2C3D4.md": constraint("A1B2C3D4", undefined),
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
      "constraints/A1/B2C3D4.md": constraint("A1B2C3D4", undefined),
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
