import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ID_RE, validateGraph } from "refino";
import { loadGraph } from "../src/loader.js";
import {
  atomicWriteFile,
  createConstraint,
  createPremise,
  deleteNode,
  updateConstraint,
  updatePremise,
} from "../src/writer.js";
import { createRefino, removeRefino } from "@refino/testkit";

describe("writer", () => {
  it("createPremise writes a body-only file when no fields are given", async () => {
    const root = await createRefino({});
    try {
      const id = await createPremise(`${root}/.refino`, { body: "PostgreSQL 16.\n" });
      expect(id).toMatch(ID_RE);
      const source = await readFile(
        `${root}/.refino/nodes/${id.slice(0, 2)}/${id.slice(2)}.premise.md`,
        "utf8",
      );
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
      const source = await readFile(
        `${root}/.refino/nodes/${id.slice(0, 2)}/${id.slice(2)}.premise.md`,
        "utf8",
      );
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
      const source = await readFile(
        `${root}/.refino/nodes/${id.slice(0, 2)}/${id.slice(2)}.constraint.md`,
        "utf8",
      );
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
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(issues).toEqual([]);
      expect(graph.nodes.size).toBe(2);
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
      const source = await readFile(`${root}/.refino/nodes/A1/B2C3D4.constraint.md`, "utf8");
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
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(issues).toEqual([]);
      expect(graph.nodes.size).toBe(1);
    } finally {
      await removeRefino(root);
    }
  });

  it("rejects an explicit id that exists as the other type as DUPLICATE_ID", async () => {
    const root = await createRefino({});
    try {
      await createPremise(`${root}/.refino`, { id: "A1B2C3D4", body: "Premise." });
      await expect(
        createConstraint(`${root}/.refino`, { id: "A1B2C3D4", body: "Constraint." }),
      ).rejects.toMatchObject({ name: "RefinoError", code: "DUPLICATE_ID" });
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(issues).toEqual([]);
      expect(graph.nodes.size).toBe(1);
      expect(graph.nodes.get("A1B2C3D4")?.type).toBe("premise");
    } finally {
      await removeRefino(root);
    }
  });

  it("generated ids avoid collisions across directories", async () => {
    const root = await createRefino({});
    try {
      await createPremise(`${root}/.refino`, { id: "A1B2C3D4", body: "Fact." });
      // Force the first generated candidate to clash with the premise id.
      const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
      const forced = [..."A1B2C3D4"].map((c) => alphabet.indexOf(c));
      const realGetRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
      let calls = 0;
      vi.stubGlobal("crypto", {
        getRandomValues(array: Uint8Array): Uint8Array {
          if (calls++ === 0) {
            array.set(forced);
            return array;
          }
          return realGetRandomValues(array);
        },
      });
      try {
        const id = await createConstraint(`${root}/.refino`, { body: "Decision." });
        expect(id).not.toBe("A1B2C3D4");
        expect(id).toMatch(ID_RE);
      } finally {
        vi.unstubAllGlobals();
      }
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(issues).toEqual([]);
      expect(graph.nodes.size).toBe(2);
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
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(issues).toEqual([]);
      expect(graph.nodes.size).toBe(2);
    } finally {
      await removeRefino(root);
    }
  });

  it("createConstraint serializes an explicit summary into frontmatter", async () => {
    const root = await createRefino({});
    try {
      const id = await createConstraint(`${root}/.refino`, {
        body: "Full decision body.".repeat(20),
        summary: "Short relevance summary.",
      });
      const source = await readFile(
        `${root}/.refino/nodes/${id.slice(0, 2)}/${id.slice(2)}.constraint.md`,
        "utf8",
      );
      expect(source).toContain("summary: Short relevance summary.");
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(issues).toEqual([]);
      expect(graph.nodes.get(id)?.summary).toBe("Short relevance summary.");
    } finally {
      await removeRefino(root);
    }
  });

  it("createPremise serializes an explicit summary into frontmatter", async () => {
    const root = await createRefino({});
    try {
      const id = await createPremise(`${root}/.refino`, {
        body: "Long fact body.",
        summary: "Fact summary.",
      });
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(issues).toEqual([]);
      expect(graph.nodes.get(id)?.summary).toBe("Fact summary.");
    } finally {
      await removeRefino(root);
    }
  });
});

describe("writer: update and delete", () => {
  it("updatePremise replaces body and fields in place", async () => {
    const root = await createRefino({});
    try {
      const id = await createPremise(`${root}/.refino`, {
        body: "Old body.",
        summary: "Old summary.",
        confirmed: "2026-05-01T00:00:00Z",
      });
      await updatePremise(`${root}/.refino`, id, {
        body: "New body.",
        summary: "New summary.",
      });
      const source = await readFile(
        `${root}/.refino/nodes/${id.slice(0, 2)}/${id.slice(2)}.premise.md`,
        "utf8",
      );
      expect(source).toContain("New body.");
      expect(source).toContain("summary: New summary.");
      expect(source).not.toContain("confirmed");
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(issues).toEqual([]);
      expect(graph.nodes.get(id)).toMatchObject({ type: "premise", body: "New body." });
      expect(graph.nodes.get(id)?.confirmed).toBeUndefined();
    } finally {
      await removeRefino(root);
    }
  });

  it("updateConstraint replaces grounds and rationale", async () => {
    const root = await createRefino({});
    try {
      const ground = await createPremise(`${root}/.refino`, { body: "Fact." });
      const id = await createConstraint(`${root}/.refino`, {
        body: "Decision.",
        grounds: [ground],
        rationale: "Old rationale.",
      });
      await updateConstraint(`${root}/.refino`, id, {
        body: "Decision v2.",
        grounds: [],
      });
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(issues).toEqual([]);
      const node = graph.nodes.get(id);
      expect(node).toMatchObject({ type: "constraint", body: "Decision v2." });
      // An explicit empty array is serialized as `grounds: []`.
      expect(node?.grounds).toEqual([]);
      expect(node?.rationale).toBeUndefined();
    } finally {
      await removeRefino(root);
    }
  });

  it.each([
    ["updatePremise", (dir: string, id: string) => updatePremise(dir, id, { body: "B." })],
    ["updateConstraint", (dir: string, id: string) => updateConstraint(dir, id, { body: "B." })],
    ["deleteNode", (dir: string, id: string) => deleteNode(dir, id)],
  ])("%s rejects a missing node as NODE_NOT_FOUND", async (_name, fn) => {
    const root = await createRefino({});
    try {
      await expect(fn(`${root}/.refino`, "A1B2C3D4")).rejects.toMatchObject({
        name: "RefinoError",
        code: "NODE_NOT_FOUND",
      });
    } finally {
      await removeRefino(root);
    }
  });

  it.each(["short", "a1b2c3d4"])("%s rejects invalid ids as INVALID_ID", async (badId) => {
    const root = await createRefino({});
    try {
      await expect(deleteNode(`${root}/.refino`, badId)).rejects.toMatchObject({
        name: "RefinoError",
        code: "INVALID_ID",
      });
    } finally {
      await removeRefino(root);
    }
  });

  it("deleteNode removes the file and leaves dangling grounds to validation", async () => {
    const root = await createRefino({});
    try {
      const groundId = await createPremise(`${root}/.refino`, { id: "A1B2C3D4", body: "Fact." });
      const id = await createConstraint(`${root}/.refino`, {
        body: "Decision.",
        grounds: [groundId],
      });
      await deleteNode(`${root}/.refino`, groundId);
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(graph.nodes.has(groundId)).toBe(false);
      expect(graph.nodes.has(id)).toBe(true);
      issues.push(...validateGraph(graph));
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ code: "UNKNOWN_GROUND", nodeId: id, groundId });
    } finally {
      await removeRefino(root);
    }
  });
});

describe("writer: atomic writes", () => {
  it("create and update leave no temp files in the shard directory", async () => {
    const root = await createRefino({});
    try {
      const id = await createPremise(`${root}/.refino`, { body: "First." });
      await updatePremise(`${root}/.refino`, id, { body: "Second." });
      const shard = `${root}/.refino/nodes/${id.slice(0, 2)}`;
      expect((await readdir(shard)).filter((name) => !name.endsWith(".md"))).toEqual([]);
      const source = await readFile(`${shard}/${id.slice(2)}.premise.md`, "utf8");
      expect(source).toBe("Second.\n");
    } finally {
      await removeRefino(root);
    }
  });

  it("atomicWriteFile removes the temp file when the rename fails", async () => {
    const root = await createRefino({});
    try {
      const dir = `${root}/.refino/nodes/A1`;
      // A directory occupying the target path makes the rename fail.
      await mkdir(`${dir}/B2C3D4.premise.md`, { recursive: true });
      await expect(atomicWriteFile(`${dir}/B2C3D4.premise.md`, "Body.\n")).rejects.toThrow();
      expect(await readdir(dir)).toEqual(["B2C3D4.premise.md"]);
    } finally {
      await removeRefino(root);
    }
  });

  it("atomicWriteFile replaces existing content and leaves no temp file", async () => {
    const root = await createRefino({});
    try {
      const file = `${root}/.refino/nodes/A1/B2C3D4.premise.md`;
      await mkdir(dirname(file), { recursive: true });
      await atomicWriteFile(file, "Old.\n");
      await atomicWriteFile(file, "New.\n");
      expect(await readFile(file, "utf8")).toBe("New.\n");
      expect((await readdir(`${root}/.refino/nodes/A1`)).filter((n) => !n.endsWith(".md"))).toEqual(
        [],
      );
    } finally {
      await removeRefino(root);
    }
  });

  it("the loader ignores stray temp files from interrupted writes", async () => {
    const root = await createRefino({});
    try {
      const id = await createPremise(`${root}/.refino`, { body: "Kept." });
      const shard = `${root}/.refino/nodes/${id.slice(0, 2)}`;
      // What a crashed process would leave behind (written, never renamed).
      await writeFile(`${shard}/${id.slice(2)}.premise.md.4242-0.tmp`, "half-written", "utf8");
      const { graph, issues } = await loadGraph(`${root}/.refino`);
      expect(issues).toEqual([]);
      expect(graph.nodes.size).toBe(1);
      expect(graph.nodes.get(id)).toMatchObject({ body: "Kept." });
    } finally {
      await removeRefino(root);
    }
  });
});
