import { describe, expect, it } from "vitest";
import { buildGraph } from "refino";
import type { Graph, NodeType, RefinoNode } from "refino";
import { checkModification, frozenZone, validateContext } from "../src/boundary.js";
import type { AuthorizationContext } from "../src/types.js";

function node(id: string, type: NodeType, grounds?: string[]): RefinoNode {
  return {
    id,
    type,
    file: `nodes/${id.slice(0, 2)}/${id.slice(2)}-${type}.md`,
    summary: "Body.",
    body: "Body.",
    ...(grounds !== undefined && { grounds }),
  };
}

/**
 * Fixture shape:
 *   1A2B3C4D ──┐
 *   A1B2C3D4 ──┴→ D4E5F6G7 → E5F6G7H8 → B2C3D4E5
 *   Z9Y8X7W6 (standalone constraint, outside the boundary)
 */
const A1 = "A1B2C3D4";
const D4 = "D4E5F6G7";
const E5 = "E5F6G7H8";
const B2 = "B2C3D4E5";
const Z9 = "Z9Y8X7W6";

function graphOf(): Graph {
  return buildGraph("/.refino", [
    node("1A2B3C4D", "premise"),
    node(A1, "constraint"),
    node(D4, "constraint", [A1]),
    node(E5, "constraint", ["1A2B3C4D", D4]),
    node(B2, "constraint", [E5]),
    node(Z9, "constraint"),
  ]);
}

describe("validateContext", () => {
  it("accepts a context whose anchors and frontier exist", () => {
    validateContext(graphOf(), { anchors: ["1A2B3C4D", A1], frontier: [E5] });
  });

  it("rejects unknown node ids", () => {
    expect(() => validateContext(graphOf(), { anchors: ["9M8N7P6Q"], frontier: [E5] })).toThrow(
      expect.objectContaining({ code: "UNKNOWN_NODE" }) as unknown as Error,
    );
  });

  it("rejects a frontier referencing a premise", () => {
    expect(() => validateContext(graphOf(), { anchors: [], frontier: ["1A2B3C4D"] })).toThrow(
      expect.objectContaining({ code: "FRONTIER_NOT_CONSTRAINT" }) as unknown as Error,
    );
  });
});

describe("frozenZone", () => {
  it("contains all constraint ancestors of the frontier, excluding the frontier", () => {
    expect(frozenZone(graphOf(), { anchors: [], frontier: [E5] }).map((n) => n.id)).toEqual([
      A1,
      D4,
    ]);
  });

  it("is empty for a root constraint frontier", () => {
    expect(frozenZone(graphOf(), { anchors: [], frontier: [A1] })).toEqual([]);
  });
});

describe("checkModification", () => {
  const ctx: AuthorizationContext = { anchors: [A1], frontier: [E5] };

  it("allows frontier nodes and their refinements", () => {
    const graph = graphOf();
    expect(checkModification(graph, ctx, E5)).toMatchObject({ zone: "frontier", allowed: true });
    expect(checkModification(graph, ctx, B2)).toMatchObject({ zone: "refinement", allowed: true });
  });

  it("blocks frozen ancestors with an escalation report", () => {
    const check = checkModification(graphOf(), ctx, D4);
    expect(check.allowed).toBe(false);
    expect(check.zone).toBe("frozen");
    expect(check.report?.affected.map((n) => n.node.id)).toEqual([E5, B2]);
  });

  it("blocks nodes outside the boundary", () => {
    const check = checkModification(graphOf(), ctx, Z9);
    expect(check.allowed).toBe(false);
    expect(check.zone).toBe("outside");
    expect(check.report?.affected).toEqual([]);
  });
});
