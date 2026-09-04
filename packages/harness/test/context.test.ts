import { describe, expect, it } from "vitest";
import { buildGraph } from "refino";
import type { Graph, NodeType, RefinoNode } from "refino";
import { contextBlocks, diffContext, renderContext } from "../src/context.js";
import type { AuthorizationContext } from "../src/types.js";

function node(id: string, type: NodeType, grounds?: string[]): RefinoNode {
  return {
    id,
    type,
    file: `nodes/${id.slice(0, 2)}/${id.slice(2)}-${type}.md`,
    summary: `${id} summary.`,
    body: `${id} body.`,
    ...(grounds !== undefined && { grounds }),
  };
}

const A1 = "A1B2C3D4";
const D4 = "D4E5F6G7";
const E5 = "E5F6G7H8";

function graphOf(): Graph {
  return buildGraph("/.refino", [
    node("1A2B3C4D", "premise"),
    node(A1, "constraint"),
    node(D4, "constraint", [A1]),
    node(E5, "constraint", [D4]),
  ]);
}

describe("contextBlocks", () => {
  it("renders stable, identifiable blocks per anchor, frozen and frontier node", () => {
    const blocks = contextBlocks(graphOf(), { anchors: ["1A2B3C4D"], frontier: [E5] });
    expect(blocks.map((b) => b.id)).toEqual([
      "anchor:1A2B3C4D",
      `frozen:${A1}`,
      `frozen:${D4}`,
      `frontier:${E5}`,
    ]);
    expect(blocks[0]!.text).toContain("1A2B3C4D summary.");
  });
});

describe("renderContext", () => {
  it("groups blocks into read-only and authorized sections", () => {
    const text = renderContext(graphOf(), { anchors: [], frontier: [E5] });
    expect(text).toContain("## 冻结区（只读依据，不可修改）");
    expect(text).toContain("## 决策前沿（授权修改的边界节点）");
    expect(text.indexOf("冻结区")).toBeLessThan(text.indexOf("决策前沿"));
  });
});

describe("diffContext", () => {
  const base: AuthorizationContext = { anchors: ["1A2B3C4D"], frontier: [E5] };

  it("reports anchor and frontier membership changes", () => {
    const events = diffContext(graphOf(), base, { anchors: [A1], frontier: [D4] });
    expect(events).toContainEqual({ type: "anchor_added", id: A1 });
    expect(events).toContainEqual({ type: "anchor_removed", id: "1A2B3C4D" });
    expect(events).toContainEqual({ type: "frontier_added", id: D4 });
    expect(events).toContainEqual({ type: "frontier_removed", id: E5 });
  });

  it("reports constraints entering and leaving the frozen zone", () => {
    const events = diffContext(graphOf(), base, { anchors: [], frontier: [D4] });
    // base frontier E5 froze {A1, D4}; the new frontier D4 freezes only {A1}
    expect(events).toContainEqual({ type: "unfrozen", id: D4 });
    expect(events.filter((e) => e.type === "frozen")).toEqual([]);
  });

  it("returns no events for identical contexts", () => {
    expect(diffContext(graphOf(), base, base)).toEqual([]);
  });
});
