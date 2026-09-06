import { describe, expect, it } from "vitest";
import { buildGraph } from "refino";
import type { Graph, NodeType, RefinoNode } from "refino";
import { contextBlocks, diffContext, estimateContext, renderContext } from "../src/context.js";
import { ZONE_PROTOCOL } from "../src/context.js";
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
  return buildGraph([
    node(P1, "premise"),
    node(A1, "constraint"),
    node(D4, "constraint", [A1]),
    node(E5, "constraint", [D4]),
  ]);
}

describe("contextBlocks", () => {
  it("renders anchors and all premises with stable ids; no frozen blocks", () => {
    const blocks = contextBlocks(graphOf(), { anchors: [A1], frozen: [E5] });
    expect(blocks.map((b) => b.id)).toEqual([`anchor:${A1}`, `premise:${P1}`]);
    expect(blocks[0]!.text).toContain("A1B2C3D4 summary.");
  });

  it("marks frozen nodes on their line, anchors and premises alike", () => {
    const blocks = contextBlocks(graphOf(), { anchors: [A1], frozen: [E5] });
    // A1 anchors the context and sits in E5's ancestor closure: its block is
    // the only place the read-only annotation can live.
    expect(blocks[0]!.text).toContain("[冻结]");
    // P1 is not in the zone: unfrozen nodes carry no mark.
    expect(blocks[1]!.text).not.toContain("[冻结]");
  });

  it("injects premises by default even when unreferenced", () => {
    const blocks = contextBlocks(graphOf(), { anchors: [], frozen: [] });
    expect(blocks.map((b) => b.id)).toEqual([`premise:${P1}`]);
  });

  it("does not duplicate a premise selected as an anchor", () => {
    const blocks = contextBlocks(graphOf(), { anchors: [P1], frozen: [] });
    expect(blocks.map((b) => b.id)).toEqual([`anchor:${P1}`]);
  });

  it("does not enumerate the frozen zone: only anchors and premises are listed", () => {
    const blocks = contextBlocks(graphOf(), { anchors: [], frozen: [D4] });
    expect(blocks.map((b) => b.id)).toEqual([`premise:${P1}`]);
    expect(blocks.some((b) => b.nodeId === A1)).toBe(false);
    expect(blocks.some((b) => b.nodeId === D4)).toBe(false);
    expect(blocks.some((b) => b.nodeId === E5)).toBe(false);
  });
});

describe("renderContext", () => {
  it("groups blocks into anchors and premises, without a frozen section", () => {
    const text = renderContext(graphOf(), { anchors: [A1], frozen: [E5] });
    expect(text).toContain("## 作用域锚点");
    expect(text).toContain("## 项目前提（客观事实）");
    expect(text.indexOf("作用域锚点")).toBeLessThan(text.indexOf("项目前提"));
    expect(text).not.toContain("## 冻结区");
  });

  it("closes with the frozen-marking protocol statement", () => {
    const text = renderContext(graphOf(), { anchors: [], frozen: [E5] });
    expect(text).toContain(ZONE_PROTOCOL);
    expect(text).toContain("标注 [冻结] 者只读");
    expect(text).toContain("未列出者均属修改空间");
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

  it("reports anchor changes and frontier-level frozen changes", () => {
    const events = diffContext(graphOf(), base, { anchors: [A1], frozen: [D4] });
    expect(events).toEqual(
      expect.arrayContaining([
        { type: "anchor_added", id: A1 },
        { type: "anchor_removed", id: P1 },
        { type: "frozen_added", id: D4 },
        { type: "frozen_removed", id: E5 },
      ]),
    );
  });

  it("events act on the declared lists only: no ancestor closure expansion", () => {
    // Freezing D4 implicitly covers A1, but the delta stays at the frontier —
    // the zone re-closes against the live graph on read.
    const events = diffContext(
      graphOf(),
      { anchors: [P1], frozen: [] },
      { anchors: [P1], frozen: [D4] },
    );
    expect(events).toEqual([{ type: "frozen_added", id: D4 }]);
  });

  it("returns no events for equivalent declarations of the same zone", () => {
    // E5 freezes {A1, D4, E5}; declaring the closure explicitly names the
    // same frontier after reduction, so the signing path never produces this
    // shape — but the diff itself only sees list membership.
    const events = diffContext(graphOf(), base, { anchors: [P1], frozen: [E5] });
    expect(events).toEqual([]);
  });

  it("returns no events for identical contexts", () => {
    expect(diffContext(graphOf(), base, base)).toEqual([]);
  });
});
