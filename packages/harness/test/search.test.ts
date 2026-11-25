import { describe, expect, it } from "vitest";
import { buildGraph } from "refino";
import type { Graph, RefinoNode } from "refino";
import type { NodeContent } from "@refino/storage";
import { searchNodes } from "../src/search.js";

function node(id: string, summary: string, type: "premise" | "decision" = "decision"): RefinoNode {
  return type === "premise" ? { id, type, summary } : { id, type, summary, grounds: [] };
}

const A1 = "A1B2C3D4";
const B2 = "B2C3D4E5";
const C3 = "C3D4E5F6";

/** Body/rationale keyed by id; ids absent here have no paged content. */
const CONTENT: Record<string, NodeContent> = {
  [A1]: { body: "使用 pnpm 作为包管理器。" },
  [B2]: { body: "正文写的是别的东西。", rationale: "因为支持 workspace 协议。" },
};

function graphOf(): Graph {
  return buildGraph([
    node(A1, "包管理器选型"),
    node(B2, "工作区协议"),
    node(C3, "无关约束"),
    node("P1PREMISE", "外部事实", "premise"),
  ]);
}

function reader(reads: string[] = []) {
  return async (id: string): Promise<NodeContent | undefined> => {
    reads.push(id);
    return CONTENT[id];
  };
}

describe("searchNodes", () => {
  it("matches id prefixes case-insensitively", async () => {
    const page = await searchNodes(graphOf(), { q: "a1b2" }, reader());
    expect(page.nodes.map((entry) => entry.id)).toEqual([A1]);
    expect(page.query).toBe("a1b2");
  });

  it("matches summary substrings case-insensitively", async () => {
    const page = await searchNodes(graphOf(), { q: "工作区" }, reader());
    expect(page.nodes.map((entry) => entry.id)).toEqual([B2]);
  });

  it("matches body substrings without reading content for cheap matches", async () => {
    const reads: string[] = [];
    const page = await searchNodes(graphOf(), { q: "pnpm" }, reader(reads));
    expect(page.nodes.map((entry) => entry.id)).toEqual([A1]);
    // C3 matched nothing cheaply and has no content; A1 matched by body only.
    expect(reads).toContain(A1);
  });

  it("matches rationale substrings", async () => {
    const page = await searchNodes(graphOf(), { q: "workspace 协议" }, reader());
    expect(page.nodes.map((entry) => entry.id)).toEqual([B2]);
  });

  it("does not read content for nodes already matched by id or summary", async () => {
    const reads: string[] = [];
    const page = await searchNodes(graphOf(), { q: "包管理器选型" }, reader(reads));
    expect(page.nodes.map((entry) => entry.id)).toEqual([A1]);
    // Other nodes are still scanned, but the matching node itself is never loaded.
    expect(reads).not.toContain(A1);
  });

  it("paginates with a keyset cursor and reports more", async () => {
    const first = await searchNodes(graphOf(), { q: "", limit: 2 }, reader());
    expect(first.nodes.map((entry) => entry.id)).toEqual(["A1B2C3D4", "B2C3D4E5"]);
    expect(first.next_cursor).toBe(B2);
    const second = await searchNodes(graphOf(), { q: "", limit: 2, cursor: B2 }, reader());
    expect(second.nodes.map((entry) => entry.id)).toEqual([C3, "P1PREMISE"]);
    expect(second.next_cursor).toBeUndefined();
  });

  it("filters by node type", async () => {
    const page = await searchNodes(graphOf(), { type: "premise" }, reader());
    expect(page.nodes.map((entry) => entry.id)).toEqual(["P1PREMISE"]);
  });

  it("returns an empty page for an unmatched query", async () => {
    const page = await searchNodes(graphOf(), { q: "无此内容" }, reader());
    expect(page.nodes).toEqual([]);
    expect(page.next_cursor).toBeUndefined();
  });
});
