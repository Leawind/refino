import { describe, expect, it } from "vitest";
import { buildGraph } from "refino";
import type { Graph, NodeType, RefinoNode } from "refino";
import { pendingReview } from "../src/pending.js";
import { HarnessSession } from "../src/session.js";
import { HarnessError } from "../src/errors.js";

function node(id: string, type: NodeType, grounds?: string[]): RefinoNode {
  const base = {
    id,
    file: `nodes/${id.slice(0, 2)}/${id.slice(2)}-${type}.md`,
    summary: "Body.",
    body: "Body.",
  };
  if (type === "premise") return { ...base, type };
  return { ...base, type, grounds: grounds ?? [] };
}

const A1 = "A1B2C3D4";
const D4 = "D4E5F6G7";
const E5 = "E5F6G7H8";
const Z9 = "Z9Y8X7W6";

function graphOf(): Graph {
  return buildGraph([
    node("1A2B3C4D", "premise"),
    node(A1, "decision"),
    node(D4, "decision", [A1, "1A2B3C4D"]),
    node(E5, "decision", [D4]),
    node(Z9, "decision", ["1A2B3C4D"]),
  ]);
}

describe("pendingReview", () => {
  it("marks only the direct dependents of the changed nodes", () => {
    // P1 is grounded on directly by D4 and Z9; E5 reaches it only through
    // D4 and is flagged when the D4 review itself modifies it.
    expect(pendingReview(graphOf(), ["1A2B3C4D"]).map((n) => n.id)).toEqual([D4, Z9]);
    expect(pendingReview(graphOf(), [A1]).map((n) => n.id)).toEqual([D4]);
  });

  it("rejects unknown node ids", () => {
    expect(() => pendingReview(graphOf(), ["9M8N7P6Q"])).toThrow(HarnessError);
  });
});

describe("HarnessSession", () => {
  it("batch queries return partial results with per-id errors", () => {
    const session = new HarnessSession(graphOf(), [A1]);
    const groups = session.dependents([A1, "9M8N7P6Q"]);
    expect(groups[0]).toEqual({
      id: A1,
      results: [
        expect.objectContaining({ node: expect.objectContaining({ id: D4 }) }),
        expect.objectContaining({ node: expect.objectContaining({ id: E5 }) }),
      ],
    });
    expect(groups[1]).toEqual({ id: "9M8N7P6Q", error: 'Node "9M8N7P6Q" not found' });
    expect(session.show(["1A2B3C4D", "9M8N7P6Q"])).toEqual([
      { id: "1A2B3C4D", results: [expect.objectContaining({ id: "1A2B3C4D" })] },
      { id: "9M8N7P6Q", error: `Node "9M8N7P6Q" not found` },
    ]);
  });

  it("carries the anchor set of the task", () => {
    const session = new HarnessSession(graphOf(), [A1, D4]);
    expect(session.anchorIds).toEqual([A1, D4]);
    expect(session.blocks().map((b) => b.id)).toEqual([`anchor:${A1}`, `anchor:${D4}`]);
  });

  it("lists nodes by type in id order", () => {
    const session = new HarnessSession(graphOf(), []);
    expect(session.listNodes("premise").map((n) => n.id)).toEqual(["1A2B3C4D"]);
    expect(session.listNodes().map((n) => n.id)).toEqual(["1A2B3C4D", A1, D4, Z9, E5].sort());
  });

  it("derives the pending-review set of a change", () => {
    const session = new HarnessSession(graphOf(), []);
    expect(session.pendingReview(["1A2B3C4D"]).map((n) => n.id)).toEqual([D4, Z9]);
  });
});
