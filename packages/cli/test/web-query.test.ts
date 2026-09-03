import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createWebApp } from "../src/web/server.js";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";

/**
 * Canvas on-demand query contract (docs/design.md, "画布按需查询") over the
 * resident index:
 *
 *   P1 1A2B3C4D   P2 1A2B3C4E   P3 1A2B3C4F
 *   C1 A1B2C3D4 grounds [P1]
 *   C2 D4E5F6G7 grounds [C1, P2]
 *   C3 E5F6G7H8 grounds [C2]
 *   C4 H7J8K9M0 grounds [C1, P2]
 *   C5 N0P1Q2R3 grounds [P3]        (separate branch)
 *   C6 S4T5V6W7 grounds [P1, P2]    (strong sibling of C1 and C2)
 */

let root: string;
let refinoDir: string;

const app = (): ReturnType<typeof createWebApp> => createWebApp({ refinoDir });

const P1 = "1A2B3C4D";
const P2 = "1A2B3C4E";
const P3 = "1A2B3C4F";
const C1 = "A1B2C3D4";
const C2 = "D4E5F6G7";
const C3 = "E5F6G7H8";
const C4 = "H7J8K9M0";
const C5 = "N0P1Q2R3";
const C6 = "S4T5V6W7";

beforeAll(async () => {
  root = await createRefino({
    "nodes/1A/2B3C4D.premise.md": premise(P1, "前提一。"),
    "nodes/1A/2B3C4E.premise.md": premise(P2, "前提二。"),
    "nodes/1A/2B3C4F.premise.md": premise(P3, "前提三。"),
    "nodes/A1/B2C3D4.constraint.md": constraint(C1, [P1], "C1。"),
    "nodes/D4/E5F6G7.constraint.md": constraint(C2, [C1, P2], "C2。"),
    "nodes/E5/F6G7H8.constraint.md": constraint(C3, [C2], "C3。"),
    "nodes/H7/J8K9M0.constraint.md": constraint(C4, [C1, P2], "C4。"),
    "nodes/N0/P1Q2R3.constraint.md": constraint(C5, [P3], "C5。"),
    "nodes/S4/T5V6W7.constraint.md": constraint(C6, [P1, P2], "C6。"),
  });
  refinoDir = join(root, ".refino");
});

afterAll(async () => {
  await removeRefino(root);
});

type QueryGroup = { id: string; results: unknown[] } | { id: string; error: string };

async function post(
  path: string,
  body: unknown,
): Promise<{ status: number; json: () => Promise<unknown> }> {
  return app().request(path, { method: "POST", body: JSON.stringify(body) });
}

describe("POST /api/query/neighbors", () => {
  it("returns bounded ancestors including premises and constraint descendants", async () => {
    const res = await post("/api/query/neighbors", {
      ids: [C3],
      ancestorDepth: 1,
      descendantDepth: 1,
    });
    expect(res.status).toBe(200);
    const groups = (await res.json()) as QueryGroup[];
    const { results } = groups[0] as {
      id: string;
      results: Array<{ truncated: boolean; nodes: Array<{ id: string; depth: number }> }>;
    };
    expect(results[0]!.truncated).toBe(false);
    // The anchor itself is part of its neighborhood at depth 0.
    expect(results[0]!.nodes.map((n) => `${n.id}:${n.depth}`)).toEqual([`${C3}:0`, `${C2}:1`]);
  });

  it("reaches premises at ancestor depth 2", async () => {
    const res = await post("/api/query/neighbors", {
      ids: [C3],
      ancestorDepth: 2,
      descendantDepth: 0,
    });
    const groups = (await res.json()) as QueryGroup[];
    const { results } = groups[0] as (typeof groups)[0] & {
      results: Array<{ nodes: Array<{ id: string; depth: number }> }>;
    };
    // depth ties are ordered by id: 1A2B3C4E < A1B2C3D4.
    expect(results[0]!.nodes.map((n) => `${n.id}:${n.depth}`)).toEqual([
      `${C3}:0`,
      `${C2}:1`,
      `${P2}:2`,
      `${C1}:2`,
    ]);
  });

  it("truncates nearest-first and flags it", async () => {
    const res = await post("/api/query/neighbors", {
      ids: [C1],
      ancestorDepth: 0,
      descendantDepth: 2,
      limit: 2,
    });
    const groups = (await res.json()) as QueryGroup[];
    const { results } = groups[0] as {
      id: string;
      results: Array<{ truncated: boolean; nodes: Array<{ id: string; depth: number }> }>;
    };
    expect(results[0]!.truncated).toBe(true);
    expect(results[0]!.nodes.map((n) => n.depth)).toEqual([0, 1]);
  });

  it("answers 207 with a per-id error for unknown ids", async () => {
    const res = await post("/api/query/neighbors", {
      ids: [C1, "ZZZZZZZZ"],
      ancestorDepth: 1,
      descendantDepth: 1,
    });
    expect(res.status).toBe(207);
    const groups = (await res.json()) as QueryGroup[];
    expect(groups[0]).toHaveProperty("results");
    expect(groups[1]).toHaveProperty("error");
  });
});

describe("POST /api/query/grounds", () => {
  it("returns direct grounds in declared order", async () => {
    const res = await post("/api/query/grounds", { ids: [C2] });
    expect(res.status).toBe(200);
    const groups = (await res.json()) as QueryGroup[];
    const { results } = groups[0] as { id: string; results: Array<{ id: string }> };
    expect(results.map((n) => n.id)).toEqual([C1, P2]);
  });

  it("answers 207 for unknown ids", async () => {
    const res = await post("/api/query/grounds", { ids: ["ZZZZZZZZ"] });
    expect(res.status).toBe(207);
  });
});

describe("POST /api/query/range", () => {
  it("selects the constraints between an ancestor-descendant pair", async () => {
    const res = await post("/api/query/range", { focusId: C3, clickedId: C1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      nodes: Array<{ id: string; depth: number }>;
    };
    expect(body.mode).toBe("ancestor");
    expect(body.nodes.map((n) => `${n.id}:${n.depth}`)).toEqual([`${C3}:0`, `${C2}:1`, `${C1}:2`]);
    expect(body.nodes.some((n) => n.id === P1)).toBe(false); // premises off-path are excluded
  });

  it("works with the focus as the ancestor", async () => {
    const res = await post("/api/query/range", { focusId: C1, clickedId: C3 });
    const body = (await res.json()) as {
      mode: string;
      nodes: Array<{ id: string; depth: number }>;
    };
    expect(body.mode).toBe("ancestor");
    expect(body.nodes.map((n) => `${n.id}:${n.depth}`)).toEqual([`${C1}:0`, `${C2}:1`, `${C3}:2`]);
  });

  it("selects both branch paths up to the nearest common ancestor", async () => {
    const res = await post("/api/query/range", { focusId: C3, clickedId: C4 });
    const body = (await res.json()) as {
      mode: string;
      nodes: Array<{ id: string; depth: number | null }>;
    };
    expect(body.mode).toBe("branches");
    expect(body.nodes.map((n) => `${n.id}:${n.depth}`)).toEqual([
      `${C3}:0`,
      `${C2}:1`,
      `${C1}:2`,
      `${C4}:3`,
    ]);
  });

  it("degrades to the clicked node for provably unrelated endpoints", async () => {
    const res = await post("/api/query/range", { focusId: C3, clickedId: C5 });
    const body = (await res.json()) as {
      mode: string;
      nodes: Array<{ id: string; depth: number | null }>;
    };
    expect(body.mode).toBe("branches");
    expect(body.nodes.map((n) => n.id)).toEqual([C5]);
    expect(body.nodes[0]!.depth).toBeNull();
  });

  it("reports disconnected when the budget runs out", async () => {
    const res = await post("/api/query/range", { focusId: C3, clickedId: C5, budget: 1 });
    const body = (await res.json()) as { mode: string; nodes: Array<{ id: string }> };
    expect(body.mode).toBe("disconnected");
    expect(body.nodes.map((n) => n.id)).toEqual([C5]);
  });

  it("answers 404 for unknown endpoints", async () => {
    const res = await post("/api/query/range", { focusId: C3, clickedId: "ZZZZZZZZ" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/query/siblings", () => {
  it("returns constraints sharing a direct ground, excluding self and premises", async () => {
    const res = await post("/api/query/siblings", { ids: [C1, C2, P1] });
    expect(res.status).toBe(200);
    const groups = (await res.json()) as QueryGroup[];
    const of = (index: number) =>
      (
        groups[index] as {
          id: string;
          results: Array<{ nodes: Array<{ id: string; overlap: number }> }>;
        }
      ).results[0]!.nodes;
    expect(of(0).map((n) => n.id)).toEqual([C6]); // C6 shares C1's direct ground P1
    expect(of(1).map((n) => n.id)).toEqual([C4, C6]); // C4 shares two grounds, C6 one
    expect(of(2)).toEqual([]); // premises have no grounds, hence no siblings
  });

  it("sorts by descending overlap, then id, and truncates", async () => {
    const res = await post("/api/query/siblings", { ids: [C2], limit: 1 });
    const groups = (await res.json()) as QueryGroup[];
    const { results } = groups[0] as {
      id: string;
      results: Array<{ truncated: boolean; nodes: Array<{ id: string }> }>;
    };
    expect(results[0]!.truncated).toBe(true);
    expect(results[0]!.nodes.map((n) => n.id)).toEqual([C4]); // overlap 2 beats overlap 1
  });
});

describe("GET /api/search", () => {
  it("paginates over ascending ids with a keyset cursor", async () => {
    const first = await app().request("/api/search?limit=4");
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as { nodes: Array<{ id: string }>; nextCursor?: string };
    expect(page1.nodes.map((n) => n.id)).toEqual([P1, P2, P3, C1]);
    expect(page1.nextCursor).toBe(C1);

    const second = await app().request(`/api/search?limit=4&cursor=${page1.nextCursor}`);
    const page2 = (await second.json()) as { nodes: Array<{ id: string }>; nextCursor?: string };
    expect(page2.nodes.map((n) => n.id)).toEqual([C2, C3, C4, C5]);
    expect(page2.nextCursor).toBe(C5);

    const last = await app().request(`/api/search?limit=4&cursor=${page2.nextCursor}`);
    const page3 = (await last.json()) as { nodes: Array<{ id: string }>; nextCursor?: string };
    expect(page3.nodes.map((n) => n.id)).toEqual([C6]);
    expect(page3.nextCursor).toBeUndefined();
  });

  it("filters by type and matches id prefixes and summary substrings", async () => {
    const byType = await app().request("/api/search?type=premise");
    let body = (await byType.json()) as { nodes: Array<{ id: string }> };
    expect(body.nodes.map((n) => n.id)).toEqual([P1, P2, P3]);

    const byPrefix = await app().request("/api/search?q=1a2b");
    body = (await byPrefix.json()) as { nodes: Array<{ id: string }> };
    expect(body.nodes.map((n) => n.id)).toEqual([P1, P2, P3]);

    const bySummary = await app().request(`/api/search?q=${encodeURIComponent("前提三")}`);
    body = (await bySummary.json()) as { nodes: Array<{ id: string }> };
    expect(body.nodes.map((n) => n.id)).toEqual([P3]);
  });

  it("rejects an invalid type filter", async () => {
    const res = await app().request("/api/search?type=nonsense");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/nodes/:id", () => {
  it("returns the full node with its revision", async () => {
    const res = await app().request(`/api/nodes/${C2}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      revision: number;
      node: { id: string; body: string; grounds: string[] };
      issues: unknown[];
    };
    expect(body.revision).toBe(1);
    expect(body.node.body).toBe("C2。");
    expect(body.node.grounds).toEqual([C1, P2]);
    expect(body.issues).toEqual([]);
  });

  it("answers 404 for unknown ids", async () => {
    const res = await app().request("/api/nodes/ZZZZZZZZ");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/graph (compatibility)", () => {
  it("serves the whole graph with bodies and the current revision", async () => {
    const res = await app().request("/api/graph");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      revision: number;
      issues: unknown[];
      nodes: Array<{ id: string; body?: string }>;
    };
    expect(body.revision).toBe(1);
    expect(body.issues).toEqual([]);
    expect(body.nodes.find((n) => n.id === C1)?.body).toBe("C1。");
  });
});
