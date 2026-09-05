import { describe, expect, it } from "vitest";
import { buildGraph } from "refino";
import type { Graph, NodeType, RefinoNode } from "refino";
import { contextBlocks, diffContext, estimateContext, renderContext } from "../src/context.js";
import type { AuthorizationContext } from "../src/types.js";

function node(id: string, type: NodeType, grounds?: string[]): RefinoNode {
  const base = {
    id,
    file: `nodes/${id.slice(0, 2)}/${id.slice(2)}-${type}.md`,
    summary: `${id} summary.`,
    body: `${id} body.`,
  };
  if (type === "premise") return { ...base, type };
  return { ...base, type, grounds: grounds ?? [] };
}

const A1 = "A1B2C3D4";
const D4 = "D4E5F6G7";
const E5 = "E5F6G7H8";
const P1 = "1A2B3C4D";

function graphOf(): Graph {
  return buildGraph("/.refino", [
    node(P1, "premise"),
    node(A1, "constraint"),
    node(D4, "constraint", [A1]),
    node(E5, "constraint", [D4]),
  ]);
}

describe("contextBlocks", () => {
  it("renders anchors, all premises and the derived frozen zone with stable ids", () => {
    const blocks = contextBlocks(graphOf(), { anchors: [A1], frozen: [E5] });
    expect(blocks.map((b) => b.id)).toEqual([
      `anchor:${A1}`,
      `premise:${P1}`,
      `frozen:${D4}`,
      `frozen:${E5}`,
    ]);
    expect(blocks[0]!.text).toContain("A1B2C3D4 summary.");
  });

  it("injects premises by default even when unreferenced", () => {
    const blocks = contextBlocks(graphOf(), { anchors: [], frozen: [] });
    expect(blocks.map((b) => b.id)).toEqual([`premise:${P1}`]);
  });

  it("does not duplicate a premise selected as an anchor", () => {
    const blocks = contextBlocks(graphOf(), { anchors: [P1], frozen: [] });
    expect(blocks.map((b) => b.id)).toEqual([`anchor:${P1}`]);
  });

  it("does not enumerate modifiable constraints outside the frozen zone", () => {
    const blocks = contextBlocks(graphOf(), { anchors: [], frozen: [D4] });
    expect(blocks.map((b) => b.id)).toEqual([`premise:${P1}`, `frozen:${A1}`, `frozen:${D4}`]);
    expect(blocks.some((b) => b.nodeId === E5)).toBe(false);
  });
});

describe("renderContext", () => {
  it("groups blocks into anchors, premises and the read-only frozen section", () => {
    const text = renderContext(graphOf(), { anchors: [], frozen: [E5] });
    expect(text).toContain("## 项目前提（客观事实）");
    expect(text).toContain("## 冻结区（只读，不可修改）");
    expect(text.indexOf("项目前提")).toBeLessThan(text.indexOf("冻结区"));
  });

  it("states the complement rule: everything outside the frozen zone is modifiable", () => {
    const text = renderContext(graphOf(), { anchors: [], frozen: [E5] });
    expect(text).toContain("冻结区以外的全部约束均属于修改空间");
  });
});

describe("estimateContext", () => {
  it("counts blocks and approximates the rendered character total", () => {
    const context: AuthorizationContext = { anchors: [A1], frozen: [E5] };
    const estimate = estimateContext(graphOf(), context);
    const blocks = contextBlocks(graphOf(), context);
    expect(estimate.blocks).toBe(blocks.length);
    // The rendered text is bounded around the estimate: never shorter than
    // the block lines, never much longer than blocks + fixed overhead.
    const rendered = renderContext(graphOf(), context);
    expect(rendered.length).toBeGreaterThanOrEqual(estimate.chars - 60);
    expect(rendered.length).toBeLessThanOrEqual(estimate.chars + 60);
  });

  it("counts the premise-only baseline for an empty context", () => {
    // Premises are injected even without anchors or a frozen zone (crg.md 2.2).
    const empty = estimateContext(graphOf(), { anchors: [], frozen: [] });
    expect(empty.blocks).toBe(1);
  });
});

describe("diffContext", () => {
  const base: AuthorizationContext = { anchors: [P1], frozen: [E5] };

  it("reports anchor changes and derived frozen-zone changes", () => {
    const events = diffContext(graphOf(), base, { anchors: [A1], frozen: [D4] });
    expect(events).toEqual(
      expect.arrayContaining([
        { type: "anchor_added", id: A1 },
        { type: "anchor_removed", id: P1 },
        { type: "frozen_removed", id: E5 },
      ]),
    );
    expect(events.filter((e) => e.type === "frozen_added")).toEqual([]);
  });

  it("emits nothing when the declared set changes but the frozen zone does not", () => {
    // E5 freezes {A1, D4, E5}; declaring the closure explicitly is equivalent.
    const events = diffContext(graphOf(), base, { anchors: [P1], frozen: [D4, E5] });
    expect(events).toEqual([]);
  });

  it("reports constraints entering the frozen zone together with their ancestors", () => {
    const events = diffContext(
      graphOf(),
      { anchors: [P1], frozen: [] },
      { anchors: [P1], frozen: [D4] },
    );
    expect(events).toEqual([
      { type: "frozen_added", id: A1 },
      { type: "frozen_added", id: D4 },
    ]);
  });

  it("returns no events for identical contexts", () => {
    expect(diffContext(graphOf(), base, base)).toEqual([]);
  });
});
