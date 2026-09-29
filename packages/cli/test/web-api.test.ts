import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createWebApp } from "../src/web/server.js";
import { loadGraph, readNode } from "@refino/storage";
import { decision, createRefino, premise, removeRefino } from "@refino/testkit";
import { IssueCode } from "refino";

let root: string;
let refinoDir: string;
let closeApp: () => void;
let app: ReturnType<typeof createWebApp>["app"];

beforeAll(async () => {
  root = await createRefino({
    "nodes/1A/2B3C4D-premise.md": premise("1A2B3C4D", "当前 PostgreSQL 版本不支持 extension X。"),
    "nodes/A1/B2C3D4-decision.md": decision(
      "A1B2C3D4",
      undefined,
      "所有业务数据存储在 PostgreSQL。",
    ),
    "nodes/D4/E5F6G7-decision.md": decision(
      "D4E5F6G7",
      ["A1B2C3D4", "1A2B3C4D"],
      "数据访问必须通过 Repository 层。",
    ),
  });
  refinoDir = join(root, ".refino");
  // One instance across all requests: every createWebApp arms a watched
  // store whose debounce and arming retries are pure overhead if repeated
  // per request, and an unclosed watcher keeps the event loop alive.
  ({ app, close: closeApp } = createWebApp({ refinoDir }));
});

afterAll(async () => {
  closeApp();
  await removeRefino(root);
});

// These are fs + watcher integration tests: the shared app arms a real store
// watcher, whose arming retries and 500ms debounce can push a single test
// past the 5s unit-test default when the full suite runs in parallel (see
// the worker-cap rationale in vitest.config.ts). Give every suite in this
// file realistic IO headroom instead of the unit default.
const ioSuite = { timeout: 20000 };

describe("refino web api", ioSuite, () => {
  it("serves the full graph with validation issues", async () => {
    const res = await app.request("/api/graph");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      issues: unknown[];
      nodes: Array<Record<string, unknown>>;
    };
    expect(body.issues).toEqual([]);
    expect(body.nodes).toHaveLength(3);
    const dependents = body.nodes.find((n) => n.id === "A1B2C3D4");
    expect(dependents?.dependents).toEqual(["D4E5F6G7"]);
  });

  it("creates a decision with grounds", async () => {
    const res = await app.request("/api/nodes/decision", {
      method: "POST",
      body: JSON.stringify({ body: "新决策。", grounds: ["A1B2C3D4"] }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const { graph } = await loadGraph(refinoDir);
    expect(graph.nodes.get(id)?.grounds).toEqual(["A1B2C3D4"]);
  });

  it("creates, exposes and settles the exploring mark", async () => {
    const created = await app.request("/api/nodes/decision", {
      method: "POST",
      body: JSON.stringify({ body: "试行决策。", exploring: true }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const detail = (await (await app.request(`/api/nodes/${id}`)).json()) as {
      node: Record<string, unknown>;
    };
    expect(detail.node.exploring).toBe(true);

    // Wholesale replacement without the mark settles the decision.
    const settled = await app.request(`/api/nodes/${id}`, {
      method: "PUT",
      body: JSON.stringify({ body: "试行决策。" }),
    });
    expect(settled.status).toBe(200);
    const after = (await (await app.request(`/api/nodes/${id}`)).json()) as {
      node: Record<string, unknown>;
    };
    expect(after.node.exploring).toBeUndefined();

    // Non-boolean values are rejected at the request boundary.
    const bad = await app.request("/api/nodes/decision", {
      method: "POST",
      body: JSON.stringify({ body: "试行。", exploring: "yes" }),
    });
    expect(bad.status).toBe(400);
  });

  it("rejects a malformed confirmed timestamp with 400", async () => {
    const res = await app.request("/api/nodes/premise", {
      method: "POST",
      body: JSON.stringify({ body: "前提。", confirmed: "上周三" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("RFC 3339");

    const created = await app.request("/api/nodes/premise", {
      method: "POST",
      body: JSON.stringify({ body: "前提。" }),
    });
    const { id } = (await created.json()) as { id: string };
    const updated = await app.request(`/api/nodes/${id}`, {
      method: "PUT",
      body: JSON.stringify({ body: "前提。", confirmed: "not-a-timestamp" }),
    });
    expect(updated.status).toBe(400);
  });

  it("rejects unknown grounds with 400", async () => {
    const res = await app.request("/api/nodes/decision", {
      method: "POST",
      body: JSON.stringify({ body: "新决策。", grounds: ["ZZZZZZZZ"] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: Array<{ code: string }> };
    expect(body.issues.some((i) => i.code === IssueCode.UnknownGround)).toBe(true);
  });

  it("rejects cycles with 400", async () => {
    const res = await app.request("/api/nodes/A1B2C3D4", {
      method: "PUT",
      body: JSON.stringify({ body: "内容。", grounds: ["D4E5F6G7"] }),
    });
    expect(res.status).toBe(400);
  });

  it("updates a node", async () => {
    const res = await app.request("/api/nodes/A1B2C3D4", {
      method: "PUT",
      body: JSON.stringify({ body: "更新后的决策。", summary: "更新后的摘要。" }),
    });
    expect(res.status).toBe(200);
    const { graph } = await loadGraph(refinoDir);
    expect(graph.nodes.get("A1B2C3D4")).toMatchObject({
      summary: "更新后的摘要。",
    });
  });

  it("removes optional fields omitted from the payload (full replace)", async () => {
    const decision = await app.request("/api/nodes/decision", {
      method: "POST",
      body: JSON.stringify({ body: "带理由的决策。", rationale: "原始理由。" }),
    });
    const { id } = (await decision.json()) as { id: string };

    // A save that carries the rationale keeps it.
    const kept = await app.request(`/api/nodes/${id}`, {
      method: "PUT",
      body: JSON.stringify({ body: "带理由的决策。", rationale: "改后的理由。", grounds: [] }),
    });
    expect(kept.status).toBe(200);
    const keptRead = await readNode(refinoDir, id);
    expect(keptRead.content?.rationale).toBe("改后的理由。");

    // A save that omits it clears it: absent means removed.
    const cleared = await app.request(`/api/nodes/${id}`, {
      method: "PUT",
      body: JSON.stringify({ body: "带理由的决策。", grounds: [] }),
    });
    expect(cleared.status).toBe(200);
    const clearedRead = await readNode(refinoDir, id);
    expect(clearedRead.content?.rationale).toBeUndefined();

    const premise = await app.request("/api/nodes/premise", {
      method: "POST",
      body: JSON.stringify({ body: "已确认的前提。", confirmed: "2026-08-01T00:00:00Z" }),
    });
    const premiseId = ((await premise.json()) as { id: string }).id;
    const clearedConfirmed = await app.request(`/api/nodes/${premiseId}`, {
      method: "PUT",
      body: JSON.stringify({ body: "已确认的前提。" }),
    });
    expect(clearedConfirmed.status).toBe(200);
    const final = await loadGraph(refinoDir);
    expect(final.graph.nodes.get(premiseId)?.confirmed).toBeUndefined();
  });

  it("refuses to delete a node with dependents (409) and deletes leaves", async () => {
    const blocked = await app.request("/api/nodes/A1B2C3D4", { method: "DELETE" });
    expect(blocked.status).toBe(409);
    const body = (await blocked.json()) as { dependents: Array<{ id: string }> };
    expect(body.dependents.some((d) => d.id === "D4E5F6G7")).toBe(true);

    const created = await app.request("/api/nodes/premise", {
      method: "POST",
      body: JSON.stringify({ body: "待删除。" }),
    });
    const { id } = (await created.json()) as { id: string };
    const deleted = await app.request(`/api/nodes/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    const { graph } = await loadGraph(refinoDir);
    expect(graph.nodes.has(id)).toBe(false);
  });

  it("rejects changing the type of an existing node", async () => {
    const res = await app.request("/api/nodes/A1B2C3D4", {
      method: "PUT",
      body: JSON.stringify({ body: "x", type: "premise" }),
    });
    expect(res.status).toBe(400);
    // The node is untouched after the rejected request.
    const { graph } = await loadGraph(refinoDir);
    expect(graph.nodes.get("A1B2C3D4")?.type).toBe("decision");
  });

  it("rejects an invalid type on create and on update", async () => {
    const update = await app.request("/api/nodes/A1B2C3D4", {
      method: "PUT",
      body: JSON.stringify({ body: "x", type: "nonsense" }),
    });
    expect(update.status).toBe(400);
  });

  it("returns 404 for unknown nodes", async () => {
    const res = await app.request("/api/nodes/ZZZZZZZZ", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("recreate a deleted id via PUT", ioSuite, () => {
  // A fresh cold store: the revision expectation below counts from load.
  let app: ReturnType<typeof createWebApp>["app"];
  let closeApp: () => void;
  beforeAll(() => {
    ({ app, close: closeApp } = createWebApp({ refinoDir }));
  });
  afterAll(() => {
    closeApp();
  });

  it("rejects a missing type and an invalid id shape", async () => {
    const noType = await app.request("/api/nodes/BB000000", {
      method: "PUT",
      body: JSON.stringify({ body: "重建。" }),
    });
    expect(noType.status).toBe(400);

    const invalid = await app.request("/api/nodes/zzzzzzzz", {
      method: "PUT",
      body: JSON.stringify({ body: "重建。", type: "decision", grounds: ["1A2B3C4D"] }),
    });
    expect(invalid.status).toBe(400);
  });

  it("creates a node under a free id and serves it afterwards", async () => {
    const created = await app.request("/api/nodes/BB000000", {
      method: "PUT",
      body: JSON.stringify({
        body: "重建的决策。",
        type: "decision",
        summary: "重建",
        grounds: ["1A2B3C4D"],
      }),
    });
    expect(created.status).toBe(201);
    // A fresh app loads at revision 1 and the create bumps it to 2.
    const { id, revision } = (await created.json()) as { id: string; revision: number };
    expect(id).toBe("BB000000");
    expect(revision).toBe(2);

    const fetched = await app.request("/api/nodes/BB000000");
    expect(fetched.status).toBe(200);
    const body = (await fetched.json()) as { node: { body: string; type: string } };
    expect(body.node.body).toBe("重建的决策。");
    expect(body.node.type).toBe("decision");
  });
});
