import { describe, expect, it } from "vitest";
import { loadGraph } from "../src/loader.js";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";
import { IssueCode } from "refino";
import { StorageIssueCode } from "../src/codes.js";

describe("loadGraph", () => {
  it("builds the resident graph with children back-references from a nodes/ directory", async () => {
    const root = await createRefino({
      "nodes/1A/2B3C4D-premise.md": premise("1A2B3C4D"),
      "nodes/A1/B2C3D4-constraint.md": constraint("A1B2C3D4", undefined),
      "nodes/D4/E5F6G7-constraint.md": constraint("D4E5F6G7", ["A1B2C3D4"]),
      "nodes/E5/F6G7H8-constraint.md": constraint("E5F6G7H8", ["1A2B3C4D", "D4E5F6G7"]),
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
      expect(graph.nodes.get("A1B2C3D4")?.children).toEqual(["D4E5F6G7"]);
      expect(graph.nodes.get("D4E5F6G7")?.children).toEqual(["E5F6G7H8"]);
      expect(graph.nodes.get("1A2B3C4D")?.children).toEqual(["E5F6G7H8"]);
      expect(graph.nodes.get("E5F6G7H8")?.children).toEqual([]);
      expect(graph.nodes.get("1A2B3C4D")?.type).toBe("premise");
      expect(graph.nodes.get("1A2B3C4D")?.confirmed).toBeUndefined();
    } finally {
      await removeRefino(root);
    }
  });

  it("derives the id from shard directory and file base name", async () => {
    const root = await createRefino({
      "nodes/01/9ABCDE-constraint.md": constraint("019ABCDE", undefined),
    });
    try {
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(issues).toEqual([]);
      expect(graph.nodes.get("019ABCDE")).toMatchObject({
        id: "019ABCDE",
        type: "constraint",
      });
    } finally {
      await removeRefino(root);
    }
  });

  it("reports duplicate ids across types and keeps the first node", async () => {
    const root = await createRefino({
      "nodes/A1/B2C3D4-premise.md": premise("A1B2C3D4"),
      "nodes/A1/B2C3D4-constraint.md": constraint("A1B2C3D4", undefined),
    });
    try {
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(graph.nodes.size).toBe(1);
      expect(issues.map((i) => i.code)).toEqual([IssueCode.DuplicateId]);
      expect(issues[0]?.nodeId).toBe("A1B2C3D4");
    } finally {
      await removeRefino(root);
    }
  });

  it.each([
    ["a stray top-level file", "nodes/A1B2C3D4.md"],
    ["a missing type segment", "nodes/A1/B2C3D4.md"],
    ["an invalid type segment", "nodes/A1/B2C3D4.decision.md"],
    ["a dot instead of the id/type separator", "nodes/A1/B2C3D4.premise.md"],
  ])("reports %s as INVALID_NODE_PATH", async (_label, file) => {
    const root = await createRefino({ [file]: "Body.\n" });
    try {
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(graph.nodes.size).toBe(0);
      expect(issues.map((i) => i.code)).toEqual([StorageIssueCode.InvalidNodePath]);
      expect(issues[0]?.file).toBe(file);
      expect(issues[0]?.message).toContain("must");
    } finally {
      await removeRefino(root);
    }
  });

  it.each([
    ["a lowercase id segment", "nodes/A1/b2c3d4-premise.md"],
    ["an empty id segment", "nodes/A1/-premise.md"],
    ["an overlong id", "nodes/A1/ABCDEFGHIJKLMNOPQ-premise.md"],
  ])("reports %s as INVALID_ID", async (_label, file) => {
    const root = await createRefino({ [file]: "Body.\n" });
    try {
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(graph.nodes.size).toBe(0);
      expect(issues.map((i) => i.code)).toEqual([IssueCode.InvalidId]);
    } finally {
      await removeRefino(root);
    }
  });

  it("silently ignores non-shard directories and non-markdown files", async () => {
    const root = await createRefino({
      "nodes/A1/B2C3D4-constraint.md": constraint("A1B2C3D4", undefined),
      "nodes/notes/keep.md": "ignored",
      "nodes/TOOLONG1/ignored.md": "ignored",
      "nodes/A1/notes.txt": "ignored",
      "nodes/A1/nested/B2C3D4-premise.md": premise("A1B2C3D4"),
    });
    try {
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(issues).toEqual([]);
      expect([...graph.nodes.keys()]).toEqual(["A1B2C3D4"]);
    } finally {
      await removeRefino(root);
    }
  });

  it("returns an empty graph when nodes/ is missing", async () => {
    const root = await createRefino({ ".keep": "" }); // .refino exists, nodes/ does not
    try {
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(issues).toEqual([]);
      expect(graph.nodes.size).toBe(0);
    } finally {
      await removeRefino(root);
    }
  });

  it("throws REFINO_DIR_NOT_FOUND when .refino does not exist", async () => {
    const root = await createRefino({});
    try {
      await expect(loadGraph(`${root}/.refino`)).rejects.toMatchObject({
        name: "RefinoError",
        code: StorageIssueCode.RefinoDirNotFound,
      });
    } finally {
      await removeRefino(root);
    }
  });
});
