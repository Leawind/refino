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
      "constraints/A1B2C3D4.md": constraint("A1B2C3D4", undefined),
      "constraints/B2C3D4E5.md": constraint("B2C3D4E5", ["A1B2C3D4"]),
      "constraints/C3D4E5F6.md": constraint("C3D4E5F6", ["A1B2C3D4"]),
      "constraints/D4E5F6G7.md": constraint("D4E5F6G7", ["B2C3D4E5", "C3D4E5F6"]),
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
      "constraints/A1B2C3D4.md": constraint("A1B2C3D4", ["Z9Y8X7W6"]),
    });
    try {
      const issues = validateGraph(graph);
      expect(issues.map((i) => i.code)).toEqual(["UNKNOWN_GROUND"]);
      expect(issues[0]).toMatchObject({ nodeId: "A1B2C3D4", groundId: "Z9Y8X7W6" });
    } finally {
      await removeRefino(root);
    }
  });

  it("reports a two-node constraint cycle exactly once with a closed path", async () => {
    const { root, graph } = await graphOf({
      "constraints/A1B2C3D4.md": constraint("A1B2C3D4", ["B2C3D4E5"]),
      "constraints/B2C3D4E5.md": constraint("B2C3D4E5", ["A1B2C3D4"]),
    });
    try {
      const issues = validateGraph(graph);
      expect(issues.map((i) => i.code)).toEqual(["CYCLE"]);
      expect(issues[0]?.cycle).toEqual(["A1B2C3D4", "B2C3D4E5", "A1B2C3D4"]);
    } finally {
      await removeRefino(root);
    }
  });

  it("reports a self-loop as a cycle", async () => {
    const { root, graph } = await graphOf({
      "constraints/A1B2C3D4.md": constraint("A1B2C3D4", ["A1B2C3D4"]),
    });
    try {
      expect(validateGraph(graph).map((i) => i.code)).toEqual(["CYCLE"]);
    } finally {
      await removeRefino(root);
    }
  });

  it("reports a three-node cycle once regardless of the entry point", async () => {
    const { root, graph } = await graphOf({
      "constraints/A1B2C3D4.md": constraint("A1B2C3D4", ["B2C3D4E5"]),
      "constraints/B2C3D4E5.md": constraint("B2C3D4E5", ["C3D4E5F6"]),
      "constraints/C3D4E5F6.md": constraint("C3D4E5F6", ["A1B2C3D4"]),
      "constraints/D4E5F6G7.md": constraint("D4E5F6G7", ["A1B2C3D4"]),
    });
    try {
      const issues = validateGraph(graph);
      expect(issues.filter((i) => i.code === "CYCLE")).toHaveLength(1);
      expect(issues[0]?.cycle).toEqual(["A1B2C3D4", "B2C3D4E5", "C3D4E5F6", "A1B2C3D4"]);
    } finally {
      await removeRefino(root);
    }
  });

  it("does not mistake shared premises for cycles", async () => {
    const { root, graph, issues } = await graphOf({
      "premises/1A2B3C4D.md": premise("1A2B3C4D"),
      "constraints/A1B2C3D4.md": constraint("A1B2C3D4", ["1A2B3C4D"]),
      "constraints/B2C3D4E5.md": constraint("B2C3D4E5", ["1A2B3C4D", "A1B2C3D4"]),
    });
    try {
      expect(issues).toEqual([]);
      expect(validateGraph(graph)).toEqual([]);
    } finally {
      await removeRefino(root);
    }
  });

  it.each([
    ["missing the UTC offset", "2026-05-01T12:00:00"],
    ["a date-only value", "2026-05-01"],
    ["not a timestamp", "yesterday"],
  ])("reports INVALID_CONFIRMED for confirmed %s", async (_label, confirmed) => {
    const { root, graph } = await graphOf({
      "premises/1A2B3C4D.md": `---\nconfirmed: ${JSON.stringify(confirmed)}\n---\n\nBody.\n`,
    });
    try {
      const issues = validateGraph(graph);
      expect(issues.map((i) => i.code)).toEqual(["INVALID_CONFIRMED"]);
      expect(issues[0]?.nodeId).toBe("1A2B3C4D");
    } finally {
      await removeRefino(root);
    }
  });

  it.each(["2026-05-01T12:00:00Z", "2026-05-01T12:00:00+08:00", "2026-05-01T12:00:00.123-05:30"])(
    "accepts confirmed %s",
    async (confirmed) => {
      const { root, graph, issues } = await graphOf({
        "premises/1A2B3C4D.md": `---\nconfirmed: ${JSON.stringify(confirmed)}\n---\n\nBody.\n`,
      });
      try {
        expect(issues).toEqual([]);
        expect(validateGraph(graph)).toEqual([]);
        expect(graph.nodes.get("1A2B3C4D")?.confirmed).toBe(confirmed);
      } finally {
        await removeRefino(root);
      }
    },
  );
});
