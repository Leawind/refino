import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createWebApp } from "../src/web/server.js";
import { GraphIndex } from "../src/web/graph-index.js";
import { createConstraint, deleteNode, updateConstraint } from "@refino/storage";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";

/**
 * Resident-index behavior: optimistic concurrency on PUT, external-write
 * absorption via reload, incremental issue rechecks and no-op suppression
 * (docs/design.md, "服务端常驻索引架构" and "外部变更同步").
 */

let root: string;
let refinoDir: string;

const P1 = "1A2B3C4D";
const C1 = "A1B2C3D4";

beforeAll(async () => {
  root = await createRefino({
    "nodes/1A/2B3C4D.premise.md": premise(P1, "前提一。"),
    "nodes/A1/B2C3D4.constraint.md": constraint(C1, [P1], "C1。"),
  });
  refinoDir = join(root, ".refino");
});

afterAll(async () => {
  await removeRefino(root);
});

describe("optimistic concurrency on PUT", () => {
  let app: ReturnType<typeof createWebApp>;
  beforeAll(() => {
    // One instance across all requests: the revision lives on the index.
    app = createWebApp({ refinoDir, staticRoot: null });
  });

  it("saves with the recorded revision, then answers 409 on a stale one", async () => {
    const opened = await app.request(`/api/nodes/${C1}`);
    const { revision } = (await opened.json()) as { revision: number };
    expect(revision).toBe(1);

    const saved = await app.request(`/api/nodes/${C1}`, {
      method: "PUT",
      body: JSON.stringify({ body: "第一次保存。", revision }),
    });
    expect(saved.status).toBe(200);
    const savedBody = (await saved.json()) as { revision: number };
    expect(savedBody.revision).toBe(revision + 1);

    const stale = await app.request(`/api/nodes/${C1}`, {
      method: "PUT",
      body: JSON.stringify({ body: "过期保存。", revision }),
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { revision: number }).revision).toBe(revision + 1);

    // Omitting the revision keeps the lenient last-write-wins behavior.
    const lenient = await app.request(`/api/nodes/${C1}`, {
      method: "PUT",
      body: JSON.stringify({ body: "无条件保存。" }),
    });
    expect(lenient.status).toBe(200);
  });

  it("reports issues instead of blocking reads when the graph is invalid", async () => {
    // External write that makes the graph invalid (tool plugins bypass the API).
    await updateConstraint(refinoDir, C1, { body: "C1。", grounds: ["ZZZZZZZZ"] });
    await app.request("/api/reload", { method: "POST" });

    const validated = await app.request("/api/validate");
    const { ok, issues } = (await validated.json()) as {
      ok: boolean;
      issues: Array<{ code: string; nodeId?: string }>;
    };
    expect(ok).toBe(false);
    expect(issues.some((i) => i.code === "UNKNOWN_GROUND" && i.nodeId === C1)).toBe(true);

    // Reads keep working alongside the issue (web read semantics).
    const graph = await app.request("/api/graph");
    expect(graph.status).toBe(200);
  });
});

describe("external writes", () => {
  it("are invisible until applied, then absorbed by reload", async () => {
    const app = createWebApp({ refinoDir, staticRoot: null });
    const before = await app.request("/api/graph");
    const beforeBody = (await before.json()) as { revision: number; nodes: Array<{ id: string }> };
    expect(beforeBody.nodes.some((n) => n.id === C1)).toBe(true);

    const newId = await createConstraint(refinoDir, { body: "外部写入。", grounds: [P1] });

    const stale = await app.request("/api/graph");
    expect(
      ((await stale.json()) as { nodes: Array<{ id: string }> }).nodes.some((n) => n.id === newId),
    ).toBe(false);

    const reload = await app.request("/api/reload", { method: "POST" });
    expect(reload.status).toBe(200);
    const event = (await reload.json()) as { revision: number; reload?: boolean };
    expect(event.reload).toBe(true);
    expect(event.revision).toBeGreaterThan(beforeBody.revision);

    const after = await app.request("/api/graph");
    const afterBody = (await after.json()) as { revision: number; nodes: Array<{ id: string }> };
    expect(afterBody.nodes.some((n) => n.id === newId)).toBe(true);
    expect(afterBody.revision).toBe(event.revision);
  });
});

describe("GraphIndex incremental updates", () => {
  it("suppresses no-op notifications and reports real changes and deletions", async () => {
    const index = new GraphIndex(refinoDir);
    await index.ready();
    const start = index.revision;

    // Re-announcing an unchanged file is a no-op: no revision bump, no event.
    expect(await index.applyChange({ changed: [C1] })).toBeUndefined();
    expect(index.revision).toBe(start);

    // A real content change bumps the revision and reports the id.
    await updateConstraint(refinoDir, C1, { body: "增量更新的内容。", grounds: [P1] });
    const changed = await index.applyChange({ changed: [C1] });
    expect(changed).toEqual({ revision: start + 1, changed: [C1], deleted: [] });
    expect(await index.readBody(C1)).toBe("增量更新的内容。");

    // An externally deleted file read back as absent turns into a deletion.
    await deleteNode(refinoDir, C1);
    const deleted = await index.applyChange({ changed: [C1] });
    expect(deleted).toEqual({ revision: start + 2, changed: [], deleted: [C1] });
    expect(index.entry(C1)).toBeUndefined();
  });

  it("rechecks issues incrementally without a full reload", async () => {
    const index = new GraphIndex(refinoDir);
    await index.ready();
    const newId = await createConstraint(refinoDir, { body: "悬空依据。", grounds: [P1] });
    await index.applyChange({ changed: [newId] });
    expect(index.issues().some((i) => i.code === "UNKNOWN_GROUND")).toBe(false);

    // Break the ground externally: the dependent's issue must appear through
    // the same incremental entry, scoped to the affected nodes.
    await updateConstraint(refinoDir, newId, { body: "悬空依据。", grounds: ["ZZZZZZZZ"] });
    await index.applyChange({ changed: [newId] });
    expect(index.issues().some((i) => i.code === "UNKNOWN_GROUND" && i.nodeId === newId)).toBe(
      true,
    );

    // Repairing the file clears the issue again.
    await updateConstraint(refinoDir, newId, { body: "悬空依据。", grounds: [P1] });
    await index.applyChange({ changed: [newId] });
    expect(index.issues()).toEqual([]);
    await deleteNode(refinoDir, newId);
    await index.applyChange({ changed: [newId] });
  });
});
