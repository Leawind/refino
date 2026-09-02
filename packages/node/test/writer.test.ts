import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ID_RE } from "refino";
import { loadGraph } from "../src/loader.js";
import { createConstraint, createPremise } from "../src/writer.js";
import { createRefino, removeRefino } from "@refino/testkit";

describe("writer", () => {
  it("createPremise writes a body-only file when no fields are given", async () => {
    const root = await createRefino({});
    try {
      const id = await createPremise(`${root}/.refino`, { body: "PostgreSQL 16.\n" });
      expect(id).toMatch(ID_RE);
      const source = await readFile(`${root}/.refino/premises/${id}.md`, "utf8");
      expect(source).toBe("PostgreSQL 16.\n");
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(issues).toEqual([]);
      expect(graph.nodes.get(id)).toMatchObject({ id, type: "premise", summary: "PostgreSQL 16." });
    } finally {
      await removeRefino(root);
    }
  });

  it("createPremise serializes confirmed into frontmatter", async () => {
    const root = await createRefino({});
    try {
      const id = await createPremise(`${root}/.refino`, {
        body: "PostgreSQL 16.\n",
        confirmed: "2026-05-01T00:00:00Z",
      });
      const source = await readFile(`${root}/.refino/premises/${id}.md`, "utf8");
      expect(source).toContain("confirmed:");
      expect(source).toContain("2026-05-01T00:00:00Z");
      expect(source.endsWith("PostgreSQL 16.\n")).toBe(true);
    } finally {
      await removeRefino(root);
    }
  });

  it("createConstraint writes grounds and rationale, and can be loaded back", async () => {
    const root = await createRefino({});
    try {
      const premiseId = await createPremise(`${root}/.refino`, { body: "Fact." });
      const id = await createConstraint(`${root}/.refino`, {
        body: "Use Repository layer.",
        grounds: [premiseId],
        rationale: "Keeps DB access testable.",
      });
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(issues).toEqual([]);
      const node = graph.nodes.get(id);
      expect(node).toMatchObject({
        type: "constraint",
        grounds: [premiseId],
        rationale: "Keeps DB access testable.",
      });
    } finally {
      await removeRefino(root);
    }
  });

  it("createConstraint omits the frontmatter block without fields", async () => {
    const root = await createRefino({});
    try {
      const id = await createConstraint(`${root}/.refino`, { body: "Root decision." });
      const source = await readFile(`${root}/.refino/constraints/${id}.md`, "utf8");
      expect(source).not.toContain("---");
      expect(source).toBe("Root decision.\n");
    } finally {
      await removeRefino(root);
    }
  });

  it("never collides with existing ids", async () => {
    const root = await createRefino({});
    try {
      const id = await createConstraint(`${root}/.refino`, { body: "First." });
      const second = await createConstraint(`${root}/.refino`, { body: "Second." });
      expect(second).not.toBe(id);
      const files = await readdir(`${root}/.refino/constraints`);
      expect(files).toHaveLength(2);
    } finally {
      await removeRefino(root);
    }
  });

  it("creates a node file under an explicitly given id", async () => {
    const root = await createRefino({});
    try {
      const id = await createConstraint(`${root}/.refino`, {
        id: "A1B2C3D4",
        body: "Explicit id.",
      });
      expect(id).toBe("A1B2C3D4");
      const source = await readFile(`${root}/.refino/constraints/A1B2C3D4.md`, "utf8");
      expect(source).toBe("Explicit id.\n");
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(issues).toEqual([]);
      expect(graph.nodes.get("A1B2C3D4")?.summary).toBe("Explicit id.");
    } finally {
      await removeRefino(root);
    }
  });

  it.each(["short", "TOOLONG1", "ILOU2345", "a1b2c3d4"])(
    "rejects explicit id %s as INVALID_ID",
    async (badId) => {
      const root = await createRefino({});
      try {
        await expect(
          createPremise(`${root}/.refino`, { id: badId, body: "Body." }),
        ).rejects.toMatchObject({ name: "RefinoError", code: "INVALID_ID" });
      } finally {
        await removeRefino(root);
      }
    },
  );

  it("rejects an explicit id that already exists as DUPLICATE_ID", async () => {
    const root = await createRefino({});
    try {
      await createPremise(`${root}/.refino`, { id: "A1B2C3D4", body: "First." });
      await expect(
        createPremise(`${root}/.refino`, { id: "A1B2C3D4", body: "Second." }),
      ).rejects.toMatchObject({ name: "RefinoError", code: "DUPLICATE_ID" });
      const files = await readdir(`${root}/.refino/premises`);
      expect(files).toEqual(["A1B2C3D4.md"]);
    } finally {
      await removeRefino(root);
    }
  });

  it("explicit ids do not disturb the generated-id collision check", async () => {
    const root = await createRefino({});
    try {
      await createConstraint(`${root}/.refino`, { id: "A1B2C3D4", body: "Explicit." });
      const generated = await createConstraint(`${root}/.refino`, { body: "Generated." });
      expect(generated).not.toBe("A1B2C3D4");
      const files = await readdir(`${root}/.refino/constraints`);
      expect(files).toHaveLength(2);
    } finally {
      await removeRefino(root);
    }
  });
});
