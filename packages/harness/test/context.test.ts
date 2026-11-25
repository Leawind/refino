import { describe, expect, it } from "vitest";
import { buildGraph } from "refino";
import type { Graph, NodeType, RefinoNode } from "refino";
import { EXPLORING_PROTOCOL, contextBlocks, diffAnchors, renderContext } from "../src/context.js";

function node(id: string, type: NodeType, grounds?: string[], exploring?: boolean): RefinoNode {
  const base = {
    id,
    file: `nodes/${id.slice(0, 2)}/${id.slice(2)}-${type}.md`,
    summary: `${id} summary.`,
    body: `${id} body.`,
  };
  if (type === "premise") return { ...base, type };
  return { ...base, type, grounds: grounds ?? [], ...(exploring ? { exploring: true } : {}) };
}

const A1 = "A1B2C3D4";
const D4 = "D4E5F6G7";
const E5 = "E5F6G7H8";
const P1 = "1A2B3C4D";

function graphOf(exploringId?: string): Graph {
  return buildGraph([
    node(P1, "premise"),
    node(A1, "decision", [], exploringId === A1),
    node(D4, "decision", [A1], exploringId === D4),
    node(E5, "decision", [D4], exploringId === E5),
  ]);
}

describe("contextBlocks", () => {
  it("renders anchors with stable ids, in anchor order and never twice", () => {
    const blocks = contextBlocks(graphOf(), [A1, P1, A1]);
    expect(blocks.map((b) => b.id)).toEqual([`anchor:${A1}`, `anchor:${P1}`]);
    expect(blocks[0]!.text).toContain("A1B2C3D4 summary.");
  });

  it("drops ids that no longer resolve", () => {
    const blocks = contextBlocks(graphOf(), [A1, "9M8N7P6Q"]);
    expect(blocks.map((b) => b.nodeId)).toEqual([A1]);
  });

  it("marks effectively exploring anchors, derived downstream included", () => {
    // A1 carries the stored mark; D4 anchors with no mark of its own but an
    // exploring ground, so the annotation must come from the closure.
    const blocks = contextBlocks(graphOf(A1), [A1, D4]);
    expect(blocks[0]!.text).toBe(`- ${A1} [decision] [探索] ${A1} summary.`);
    expect(blocks[1]!.text).toContain("[探索]");
    const plain = contextBlocks(graphOf(), [A1]);
    expect(plain[0]!.text).not.toContain("[探索]");
    // Premises are never exploring.
    const premiseAnchor = contextBlocks(graphOf(A1), [P1]);
    expect(premiseAnchor[0]!.text).not.toContain("[探索]");
  });
});

describe("renderContext", () => {
  it("groups anchors under one heading and closes with the protocol statement", () => {
    const text = renderContext(graphOf(), [A1]);
    expect(text).toContain("## 作用域锚点");
    expect(text).toContain(`- ${A1} [decision] ${A1} summary.`);
    expect(text).toContain(EXPLORING_PROTOCOL);
    expect(text).not.toContain("预先冻结");
  });

  it("renders only the protocol statement for an empty anchor set", () => {
    const text = renderContext(graphOf(), []);
    expect(text).toBe(EXPLORING_PROTOCOL);
  });

  it("cites summaries only, never bodies", () => {
    const text = renderContext(graphOf(), [A1, D4, E5]);
    expect(text).not.toContain("body");
  });
});

describe("diffAnchors", () => {
  it("reports added and removed ids", () => {
    expect(diffAnchors([A1], [A1, D4])).toEqual([{ type: "anchor_added", id: D4 }]);
    expect(diffAnchors([A1, D4], [D4])).toEqual([{ type: "anchor_removed", id: A1 }]);
  });

  it("is empty for an unchanged anchor set, order included", () => {
    expect(diffAnchors([A1, D4], [A1, D4])).toEqual([]);
    expect(diffAnchors([], [])).toEqual([]);
  });
});
