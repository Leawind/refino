import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createConstraint, createPremise, ID_RE } from "../src/index.js";
import { loadGraph } from "../src/loader.js";
import { createRefino, removeRefino } from "./helpers.js";

describe("writer", () => {
  it("generateId produces valid Crockford base32 ids", () => {
    expect(ID_RE.test("01234567")).toBe(true);
    expect(ID_RE.test("ABCDEFGH")).toBe(true);
    expect(ID_RE.test("ILOU2345")).toBe(false);
    expect(ID_RE.test("short")).toBe(false);
  });

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
});
