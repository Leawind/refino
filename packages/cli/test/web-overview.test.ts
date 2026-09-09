import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebApp } from "../src/web/server.js";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";

/**
 * Project-overview endpoints (docs/design.md, "后端 API 契约"): /api/stats
 * counts and the roots/unreferenced filters on /api/search.
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
