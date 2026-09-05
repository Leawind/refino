import { join } from "node:path";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createWebApp } from "../src/web/server.js";
import { GraphIndex } from "../src/web/graph-index.js";
import { createConstraint, deleteNode, StorageIssueCode, updateConstraint } from "@refino/storage";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";
import { IssueCode } from "refino";

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
    expect(index.issues().some((i) => i.code === IssueCode.UnknownGround)).toBe(false);

    // Break the ground externally: the dependent's issue must appear through
    // the same incremental entry, scoped to the affected nodes.
    await updateConstraint(refinoDir, newId, { body: "悬空依据。", grounds: ["ZZZZZZZZ"] });
    await index.applyChange({ changed: [newId] });
    expect(
      index.issues().some((i) => i.code === IssueCode.UnknownGround && i.nodeId === newId),
    ).toBe(true);

    // Repairing the file clears the issue again.
    await updateConstraint(refinoDir, newId, { body: "悬空依据。", grounds: [P1] });
    await index.applyChange({ changed: [newId] });
    expect(index.issues()).toEqual([]);
    await deleteNode(refinoDir, newId);
    await index.applyChange({ changed: [newId] });
  });

  it("surfaces parse issues from external changes without a reload", async () => {
    const index = new GraphIndex(refinoDir);
    await index.ready();
    expect(index.issues()).toEqual([]);

    // A premise with an empty "summary" frontmatter field: a parse-level
    // issue invisible to the structural recheck, reported by readNode only.
    const shardDir = join(refinoDir, "nodes", "9A");
    await mkdir(shardDir, { recursive: true });
    await writeFile(
      join(shardDir, "ABCDEF1-premise.md"),
      '---\nsummary: ""\n---\n\n摘要字段为空的前提。\n',
      "utf8",
    );
    await index.applyChange({ changed: ["9AABCDEF1"] });
    expect(index.issues().some((i) => i.code === StorageIssueCode.InvalidFrontmatter)).toBe(true);

    // Repairing the file clears the issue through the same entry.
    await writeFile(join(shardDir, "ABCDEF1-premise.md"), "修复后的前提。\n", "utf8");
    const event = await index.applyChange({ changed: ["9AABCDEF1"] });
    expect(event?.changed).toEqual(["9AABCDEF1"]);
    expect(index.issues()).toEqual([]);
  });

  it("keeps a node's parse issues when only its dependents are rechecked", async () => {
    const index = new GraphIndex(refinoDir);
    await index.ready();

    // P with a parse issue, grounded on by C: rechecking C (or any change
    // touching C) pulls P into the affected set and must not erase P's own
    // parse issue.
    const shardDir = join(refinoDir, "nodes", "9B");
    await mkdir(shardDir, { recursive: true });
    await writeFile(
      join(shardDir, "ABCDEF2-premise.md"),
      '---\nsummary: ""\n---\n\n带空摘要的前提。\n',
      "utf8",
    );
    const dependent = await createConstraint(refinoDir, { body: "下游。", grounds: ["9BABCDEF2"] });
    await index.applyChange({ changed: ["9BABCDEF2", dependent] });
    expect(index.issues().some((i) => i.code === StorageIssueCode.InvalidFrontmatter)).toBe(true);

    // A change to the dependent rechecks the premise too; its parse issue survives.
    await updateConstraint(refinoDir, dependent, { body: "下游改。", grounds: ["9BABCDEF2"] });
    await index.applyChange({ changed: [dependent] });
    expect(index.issues().some((i) => i.code === StorageIssueCode.InvalidFrontmatter)).toBe(true);

    await deleteNode(refinoDir, dependent);
    await index.applyChange({ changed: [dependent] });
  });

  it("reports parse issues of files that yield no node at all", async () => {
    const index = new GraphIndex(refinoDir);
    await index.ready();

    // Broken YAML: readNode returns no node but reports the parse issue,
    // keyed by file; the issue must surface through the incremental entry.
    const shardDir = join(refinoDir, "nodes", "9C");
    await mkdir(shardDir, { recursive: true });
    await writeFile(
      join(shardDir, "ABCDEF3-premise.md"),
      "---\n\t[broken yaml\n---\n\n正文。\n",
      "utf8",
    );
    const first = await index.applyChange({ changed: ["9CABCDEF3"] });
    expect(first).toBeDefined();
    expect(index.issues().some((i) => i.code === StorageIssueCode.InvalidFrontmatter)).toBe(true);

    // A no-op echo of the same broken file must not bump the revision.
    const revision = index.revision;
    expect(await index.applyChange({ changed: ["9CABCDEF3"] })).toBeUndefined();
    expect(index.revision).toBe(revision);
  });

  it("drops parse issues keyed by files that vanish within a touched shard", async () => {
    const index = new GraphIndex(refinoDir);
    await index.ready();

    // A lowercase id segment cannot form a valid id; the parse issue is keyed by file.
    const shardDir = join(refinoDir, "nodes", "AA");
    const badFile = join(shardDir, "zz-premise.md");
    await mkdir(shardDir, { recursive: true });
    await writeFile(badFile, "---\ntype: constraint\nsummary: 形状非法\n---\n正文。\n", "utf8");
    await index.reload();
    const invalidIssue = () => index.issues().find((i) => i.code === IssueCode.InvalidId);
    expect(invalidIssue()?.file).toBe("nodes/AA/zz-premise.md");

    // Renaming it into shape reports the new id; the touched shard lets the
    // index drop the stale file-keyed issue without a full reload.
    await rename(badFile, join(shardDir, "7P8Q9R-premise.md"));
    const event = await index.applyChange({ changed: ["AA7P8Q9R"], shards: ["AA"] });
    expect(event).toBeDefined();
    expect(index.entry("AA7P8Q9R")).toBeDefined();
    expect(invalidIssue()).toBeUndefined();

    // A shard-only batch without anything stale is a no-op.
    expect(await index.applyChange({ shards: ["AA"] })).toBeUndefined();
  });
});
