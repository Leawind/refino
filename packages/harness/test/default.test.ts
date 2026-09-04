import { describe, expect, it } from "vitest";
import { buildGraph } from "refino";
import type { Graph, NodeType, RefinoNode } from "refino";
import { defaultAuthorizationContext } from "../src/default.js";

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

function graphOf(): Graph {
  return buildGraph("/.refino", [
    node("1A2B3C4D", "premise"),
    node(A1, "constraint"),
    node(D4, "constraint", [A1]),
  ]);
}

describe("defaultAuthorizationContext", () => {
  it("freezes root constraints and anchors every node on a small graph", () => {
    const { context, complete } = defaultAuthorizationContext(graphOf());
    expect(complete).toBe(true);
    expect(context.frozen).toEqual([A1]);
    expect(context.anchors).toEqual(["1A2B3C4D", A1, D4]);
  });

  it("requires explicit anchors once the graph exceeds the node budget", () => {
    const { context, complete } = defaultAuthorizationContext(graphOf(), 2);
    expect(complete).toBe(false);
    expect(context.anchors).toEqual([]);
    expect(context.frozen).toEqual([A1]);
  });
});
