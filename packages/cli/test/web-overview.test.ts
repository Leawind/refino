import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebApp } from "../src/web/server.js";
import { RefinoStore } from "@refino/storage";
import { WebState } from "../src/web/web-state.js";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";

/**
 * Project-overview and review endpoints (docs/design.md, "后端 API 契约"):
 * /api/stats counts, the roots filter on /api/search, and the derived
 * pending-review set served by /api/pending.
 */

const P1 = "1A2B3C4D";
const R1 = "A1B2C3D4";
const C1 = "D4E5F6G7";

let root: string;
let refinoDir: string;

const app = (): ReturnType<typeof createWebApp> => createWebApp({ refinoDir });

beforeAll(async () => {
  root = await createRefino({
    "nodes/1A/2B3C4D-premise.md": premise(P1, "前提一。"),
    "nodes/A1/B2C3D4-constraint.md": constraint(R1, [], "根约束一。"),
    "nodes/D4/E5F6G7-constraint.md": constraint(C1, [R1, P1], "细化约束一。"),
  });
  refinoDir = join(root, ".refino");
});

afterAll(async () => {
  await removeRefino(root);
});

describe("GET /api/stats", () => {
  it("reports node, type and root counts with the revision", async () => {
    const res = await app().request("/api/stats");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      revision: 1,
      nodes: 3,
      constraints: 2,
      premises: 1,
      roots: 1,
    });
  });
});

describe("GET /api/search roots filter", () => {
  it("returns only root constraints", async () => {
    const res = await app().request("/api/search?roots=1");
    const body = (await res.json()) as { nodes: Array<{ id: string }> };
    expect(body.nodes.map((n) => n.id)).toEqual([R1]);
  });

  it("combines with the query and returns an empty page when nothing matches", async () => {
    const miss = await app().request("/api/search?roots=1&q=细化");
    expect(((await miss.json()) as { nodes: unknown[] }).nodes).toEqual([]);

    const hit = await app().request("/api/search?roots=1&q=根约束");
    expect(((await hit.json()) as { nodes: Array<{ id: string }> }).nodes.map((n) => n.id)).toEqual(
      [R1],
    );
  });

  it("ignores other spellings of the flag", async () => {
    const res = await app().request("/api/search?roots=yes");
    const body = (await res.json()) as { nodes: Array<{ id: string }> };
    expect(body.nodes).toHaveLength(3);
  });
});

describe("GET /api/search unreferenced filter", () => {
  it("returns only premises no constraint grounds on", async () => {
    // The fixture's premise is referenced by C1; create an unreferenced one.
    const created = await app().request("/api/nodes/premise", {
      method: "POST",
      body: JSON.stringify({ body: "未被引用的前提。", summary: "孤儿前提" }),
    });
    expect(created.status).toBe(201);

    const res = await app().request("/api/search?unreferenced=1");
    const body = (await res.json()) as { nodes: Array<{ id: string; type: string }> };
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0]!.type).toBe("premise");
    expect(body.nodes[0]!.id).not.toBe("1A2B3C4D");
  });
});

describe("GET /api/pending", () => {
  // Each test gets one app for all its requests: the pending set lives in
  // the index's memory and must not be recreated between calls.
  const newApp = (): ReturnType<typeof createWebApp> => createWebApp({ refinoDir });

  it("starts empty and accumulates the direct dependents of changed nodes", async () => {
    const target = newApp();
    const initial = await target.request("/api/pending");
    expect(((await initial.json()) as { nodes: unknown[] }).nodes).toEqual([]);

    const updated = await target.request(`/api/nodes/${R1}`, {
      method: "PUT",
      body: JSON.stringify({ body: "根约束一（修订）。", summary: "根约束一。", grounds: [] }),
    });
    expect(updated.status).toBe(200);

    const pending = await target.request("/api/pending");
    const body = (await pending.json()) as { revision: number; nodes: Array<{ id: string }> };
    expect(body.nodes.map((n) => n.id)).toEqual([C1]);
    expect(body.nodes[0]).toMatchObject({ type: "constraint" });
  });

  it("restarts the accumulation window on POST /api/reload", async () => {
    const target = newApp();
    const touched = await target.request(`/api/nodes/${R1}`, {
      method: "PUT",
      body: JSON.stringify({ body: "根约束一（再修订）。", summary: "根约束一。", grounds: [] }),
    });
    expect(touched.status).toBe(200);
    const before = (await (await target.request("/api/pending")).json()) as {
      nodes: Array<{ id: string }>;
    };
    expect(before.nodes.length).toBeGreaterThan(0);

    const reloaded = await target.request("/api/reload", { method: "POST" });
    expect(reloaded.status).toBe(200);

    const pending = await target.request("/api/pending");
    expect(((await pending.json()) as { nodes: unknown[] }).nodes).toEqual([]);
  });
});

describe("pending derivation for externally deleted nodes", () => {
  it("adds the pre-mutation dependents of a deleted change target", async () => {
    // A fresh web state over the same directory starts with an empty window.
    const store = RefinoStore.open(refinoDir);
    const web = new WebState(store);
    try {
      await store.ready();
      expect(web.pending()).toHaveLength(0);

      // Deleting P1 externally leaves C1 (its dependent, captured pre-mutation)
      // reviewing the removal.
      await rm(join(refinoDir, "nodes", "1A", "2B3C4D-premise.md"));
      const event = await store.applyChange({ deleted: [P1], origin: "file" });
      expect(event?.deleted).toEqual([P1]);
      expect(web.pending().map((n) => n.id)).toEqual([C1]);
    } finally {
      web.close();
      store.close();
    }
  });
});
