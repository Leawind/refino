import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createWebApp } from "../src/web/server.js";
import { createConstraint, updateConstraint } from "@refino/storage";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";
import { IssueCode } from "refino";

/**
 * Web-level resident behavior over the storage Store: optimistic concurrency
 * on PUT, external-write absorption via reload and issue surfacing
 * (docs/design.md, "服务端常驻索引架构" and "外部变更同步"). The store's own
 * incremental-update semantics live in @refino/storage's tests.
 */

let root: string;
let refinoDir: string;

const P1 = "1A2B3C4D";
const C1 = "A1B2C3D4";

beforeAll(async () => {
  root = await createRefino({
    "nodes/1A/2B3C4D-premise.md": premise(P1, "前提一。"),
    "nodes/A1/B2C3D4-constraint.md": constraint(C1, [P1], "C1。"),
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

  it("detects body-only external edits via mtime and guards PUT", async () => {
    // An explicit summary pins the light fields: only the body and mtime differ.
    const created = await app.request("/api/nodes/constraint", {
      method: "POST",
      body: JSON.stringify({ body: "首段。\n\n第二段。", summary: "固定摘要。", grounds: [P1] }),
    });
    const { id, revision } = (await created.json()) as { id: string; revision: number };

    await updateConstraint(refinoDir, id, {
      body: "首段。\n\n第二段已改写。",
      summary: "固定摘要。",
      grounds: [P1],
    });
    await app.request("/api/reload", { method: "POST" });

    const opened = await app.request(`/api/nodes/${id}`);
    const snapshot = (await opened.json()) as { revision: number; node: { body: string } };
    expect(snapshot.revision).toBeGreaterThan(revision);
    expect(snapshot.node.body).toContain("第二段已改写");

    // The revision recorded before the external edit no longer saves.
    const stale = await app.request(`/api/nodes/${id}`, {
      method: "PUT",
      body: JSON.stringify({ body: "旧内容。", summary: "固定摘要。", grounds: [P1], revision }),
    });
    expect(stale.status).toBe(409);
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
    expect(issues.some((i) => i.code === IssueCode.UnknownGround && i.nodeId === C1)).toBe(true);

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
