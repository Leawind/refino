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
  return buildGraph("/.refino", [
    node("1A2B3C4D", "premise"),
    node(A1, "constraint"),
    node(D4, "constraint", [A1, "1A2B3C4D"]),
    node(E5, "constraint", [D4]),
    node(Z9, "constraint", ["1A2B3C4D"]),
  ]);
}

describe("pendingReview", () => {
  it("collects the deduplicated union of dependents of changed premises", () => {
    expect(pendingReview(graphOf(), ["1A2B3C4D"]).map((n) => n.id)).toEqual([D4, E5, Z9]);
    expect(pendingReview(graphOf(), [A1]).map((n) => n.id)).toEqual([D4, E5]);
  });

  it("rejects unknown node ids", () => {
    expect(() => pendingReview(graphOf(), ["9M8N7P6Q"])).toThrow(HarnessError);
  });
});

describe("HarnessSession", () => {
  const ctx = { anchors: [A1], frozen: [Z9] };

  it("batch queries return partial results with per-id errors", () => {
    const session = new HarnessSession(graphOf(), ctx);
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

  it("updateContext returns the incremental delta and switches the context", () => {
    const session = new HarnessSession(graphOf(), ctx);
    const delta = session.updateContext({ anchors: [A1], frozen: [Z9, D4] });
    // Freezing D4 pulls its ancestor A1 into the zone as well.
    expect(delta).toEqual([
      { type: "frozen_added", id: A1 },
      { type: "frozen_added", id: D4 },
    ]);
    expect(session.authorizationContext.frozen).toEqual([Z9, D4]);
    expect(session.blocks().map((b) => b.id)).toContain("frozen:D4E5F6G7");
  });

  it("checkModification applies the current context", () => {
    const session = new HarnessSession(graphOf(), ctx);
    expect(session.checkModification([Z9])[0]).toMatchObject({ zone: "frozen", allowed: false });
    expect(session.checkModification([E5])[0]).toMatchObject({ zone: "modifiable", allowed: true });
  });
});
