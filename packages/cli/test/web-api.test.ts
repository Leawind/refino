import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createWebApp } from "../src/web/server.js";
import { loadGraph } from "@refino/storage";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";

let root: string;
let refinoDir: string;

/** Fresh app bound to the fixture's refinoDir (assigned in beforeAll). */
const app = (): ReturnType<typeof createWebApp> => createWebApp({ refinoDir });

beforeAll(async () => {
  root = await createRefino({
    "nodes/1A/2B3C4D-premise.md": premise("1A2B3C4D", "当前 PostgreSQL 版本不支持 extension X。"),
    "nodes/A1/B2C3D4-constraint.md": constraint(
      "A1B2C3D4",
      undefined,
      "所有业务数据存储在 PostgreSQL。",
    ),
    "nodes/D4/E5F6G7-constraint.md": constraint(
      "D4E5F6G7",
      ["A1B2C3D4", "1A2B3C4D"],
      "数据访问必须通过 Repository 层。",
    ),
  });
  refinoDir = join(root, ".refino");
});

afterAll(async () => {
  await removeRefino(root);
});

describe("refino web api", () => {
  it("serves the full graph with validation issues", async () => {
    const res = await app().request("/api/graph");
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

  it("creates a constraint with grounds", async () => {
    const res = await app().request("/api/nodes/constraint", {
      method: "POST",
      body: JSON.stringify({ body: "新约束。", grounds: ["A1B2C3D4"] }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const { graph } = await loadGraph(refinoDir);
    expect(graph.nodes.get(id)?.grounds).toEqual(["A1B2C3D4"]);
  });

  it("rejects unknown grounds with 400", async () => {
    const res = await app().request("/api/nodes/constraint", {
      method: "POST",
      body: JSON.stringify({ body: "新约束。", grounds: ["ZZZZZZZZ"] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("ZZZZZZZZ");
  });

  it("rejects cycles with 400", async () => {
    const res = await app().request("/api/nodes/A1B2C3D4", {
      method: "PUT",
      body: JSON.stringify({ body: "内容。", grounds: ["D4E5F6G7"] }),
    });
    expect(res.status).toBe(400);
  });

  it("updates a node", async () => {
    const res = await app().request("/api/nodes/A1B2C3D4", {
      method: "PUT",
      body: JSON.stringify({ body: "更新后的决策。", summary: "更新后的摘要。" }),
    });
    expect(res.status).toBe(200);
    const { graph } = await loadGraph(refinoDir);
    expect(graph.nodes.get("A1B2C3D4")).toMatchObject({
      body: "更新后的决策。",
      summary: "更新后的摘要。",
    });
  });

  it("refuses to delete a node with dependents (409) and deletes leaves", async () => {
    const blocked = await app().request("/api/nodes/A1B2C3D4", { method: "DELETE" });
    expect(blocked.status).toBe(409);
    const body = (await blocked.json()) as { dependents: Array<{ id: string }> };
    expect(body.dependents.some((d) => d.id === "D4E5F6G7")).toBe(true);

    const created = await app().request("/api/nodes/premise", {
      method: "POST",
      body: JSON.stringify({ body: "待删除。" }),
    });
    const { id } = (await created.json()) as { id: string };
    const deleted = await app().request(`/api/nodes/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    const { graph } = await loadGraph(refinoDir);
    expect(graph.nodes.has(id)).toBe(false);
  });

  it("rejects changing the type of an existing node", async () => {
    const res = await app().request("/api/nodes/A1B2C3D4", {
      method: "PUT",
      body: JSON.stringify({ body: "x", type: "premise" }),
    });
    expect(res.status).toBe(400);
    // The node is untouched after the rejected request.
    const { graph } = await loadGraph(refinoDir);
    expect(graph.nodes.get("A1B2C3D4")?.type).toBe("constraint");
  });

  it("rejects an invalid type on create and on update", async () => {
    const update = await app().request("/api/nodes/A1B2C3D4", {
      method: "PUT",
      body: JSON.stringify({ body: "x", type: "nonsense" }),
    });
    expect(update.status).toBe(400);
  });

  it("returns 404 for unknown nodes", async () => {
    const res = await app().request("/api/nodes/ZZZZZZZZ", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("recreate a deleted id via PUT", () => {
  it("rejects a missing type and an invalid id shape", async () => {
    const noType = await app().request("/api/nodes/BB000000", {
      method: "PUT",
      body: JSON.stringify({ body: "重建。" }),
    });
    expect(noType.status).toBe(400);

    const invalid = await app().request("/api/nodes/zzzzzzzz", {
      method: "PUT",
      body: JSON.stringify({ body: "重建。", type: "constraint", grounds: ["1A2B3C4D"] }),
    });
    expect(invalid.status).toBe(400);
  });

  it("creates a node under a free id and serves it afterwards", async () => {
    const created = await app().request("/api/nodes/BB000000", {
      method: "PUT",
      body: JSON.stringify({
        body: "重建的约束。",
        type: "constraint",
        summary: "重建",
        grounds: ["1A2B3C4D"],
      }),
    });
    expect(created.status).toBe(201);
    // A fresh app loads at revision 1 and the create bumps it to 2.
    const { id, revision } = (await created.json()) as { id: string; revision: number };
    expect(id).toBe("BB000000");
    expect(revision).toBe(2);

    const fetched = await app().request("/api/nodes/BB000000");
    expect(fetched.status).toBe(200);
    const body = (await fetched.json()) as { node: { body: string; type: string } };
    expect(body.node.body).toBe("重建的约束。");
    expect(body.node.type).toBe("constraint");
  });
});
