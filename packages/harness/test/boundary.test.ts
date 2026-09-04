import { describe, expect, it } from "vitest";
import { buildGraph } from "refino";
import type { Graph, NodeType, RefinoNode } from "refino";
import {
  checkModification,
  freezableConstraints,
  frozenDependents,
  frozenFrontier,
  frozenZone,
  validateContext,
} from "../src/boundary.js";
import { HarnessError } from "../src/errors.js";
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
 *   1A2B3C4D (premise) ──┬→ D4E5F6G7 → E5F6G7H8 → B2C3D4E5
 *   A1B2C3D4 (root) ─────┘
 *   Z9Y8X7W6 (standalone root constraint)
 */
const A1 = "A1B2C3D4";
const D4 = "D4E5F6G7";
const E5 = "E5F6G7H8";
const B2 = "B2C3D4E5";
const Z9 = "Z9Y8X7W6";
const P1 = "1A2B3C4D";

function graphOf(): Graph {
  return buildGraph("/.refino", [
    node(P1, "premise"),
    node(A1, "constraint"),
    node(D4, "constraint", [A1]),
    node(E5, "constraint", [P1, D4]),
    node(B2, "constraint", [E5]),
    node(Z9, "constraint"),
  ]);
}

describe("validateContext", () => {
  it("accepts a context whose anchors and frozen list exist", () => {
    validateContext(graphOf(), { anchors: [P1, A1], frozen: [E5] });
  });

  it("accepts an empty frozen list: the whole graph is the modification space", () => {
    validateContext(graphOf(), { anchors: [], frozen: [] });
  });

  it("rejects unknown node ids", () => {
    expect(() => validateContext(graphOf(), { anchors: ["9M8N7P6Q"], frozen: [E5] })).toThrow(
      expect.objectContaining({ code: "UNKNOWN_NODE" }) as unknown as Error,
    );
  });

  it("rejects a frozen list referencing a premise", () => {
    expect(() => validateContext(graphOf(), { anchors: [], frozen: [P1] })).toThrow(
      expect.objectContaining({ code: "FROZEN_NOT_CONSTRAINT" }) as unknown as Error,
    );
  });
});

describe("frozenZone", () => {
  it("returns the named constraints closed upwards over all ancestors, sorted", () => {
    expect(frozenZone(graphOf(), { anchors: [], frozen: [E5, A1] }).map((n) => n.id)).toEqual([
      P1,
      A1,
      D4,
      E5,
    ]);
  });

  it("freezing a node implicitly freezes its ancestors, constraints and premises alike", () => {
    expect(frozenZone(graphOf(), { anchors: [], frozen: [D4] }).map((n) => n.id)).toEqual([A1, D4]);
    expect(frozenZone(graphOf(), { anchors: [], frozen: [E5] }).map((n) => n.id)).toEqual([
      P1,
      A1,
      D4,
      E5,
    ]);
  });

  it("is empty for an empty frozen list", () => {
    expect(frozenZone(graphOf(), { anchors: [], frozen: [] })).toEqual([]);
  });
});

describe("checkModification", () => {
  const ctx: AuthorizationContext = { anchors: [A1], frozen: [A1, Z9] };

  it("allows everything outside the frozen zone", () => {
    const graph = graphOf();
    expect(checkModification(graph, ctx, D4)).toMatchObject({ zone: "modifiable", allowed: true });
    expect(checkModification(graph, ctx, E5)).toMatchObject({ zone: "modifiable", allowed: true });
    expect(checkModification(graph, ctx, B2)).toMatchObject({ zone: "modifiable", allowed: true });
  });

  it("blocks frozen constraints with an escalation report", () => {
    const check = checkModification(graphOf(), ctx, A1);
    expect(check.allowed).toBe(false);
    expect(check.zone).toBe("frozen");
    expect(check.report?.zone).toBe("frozen");
    expect(check.report?.affected.map((n) => n.node.id)).toEqual([D4, E5, B2]);
  });

  it("blocks ancestors pulled into the zone by a frozen refinement", () => {
    const ctx: AuthorizationContext = { anchors: [], frozen: [D4] };
    expect(checkModification(graphOf(), ctx, A1)).toMatchObject({ zone: "frozen", allowed: false });
    expect(checkModification(graphOf(), ctx, E5)).toMatchObject({
      zone: "modifiable",
      allowed: true,
    });
  });

  it("blocks premise updates: they follow the maintenance protocol", () => {
    const check = checkModification(graphOf(), ctx, P1);
    expect(check.allowed).toBe(false);
    expect(check.zone).toBe("premise");
    expect(check.report?.zone).toBe("premise");
    expect(check.report?.affected.map((n) => n.node.id)).toEqual([E5, B2]);
  });

  it("throws on unknown ids", () => {
    expect(() => checkModification(graphOf(), ctx, "9M8N7P6Q")).toThrow(HarnessError);
  });
});

describe("frozenFrontier", () => {
  it("returns the zone's most downstream constraints", () => {
    expect(frozenFrontier(graphOf(), { anchors: [], frozen: [E5] }).map((n) => n.id)).toEqual([E5]);
  });

  it("determines the zone regardless of which subset was declared", () => {
    expect(frozenFrontier(graphOf(), { anchors: [], frozen: [D4, E5] }).map((n) => n.id)).toEqual([
      E5,
    ]);
  });

  it("keeps unrelated roots as separate frontier nodes", () => {
    expect(frozenFrontier(graphOf(), { anchors: [], frozen: [A1, Z9] }).map((n) => n.id)).toEqual([
      A1,
      Z9,
    ]);
  });

  it("is empty for an empty frozen list", () => {
    expect(frozenFrontier(graphOf(), { anchors: [], frozen: [] })).toEqual([]);
  });
});

describe("freezableConstraints", () => {
  it("offers every constraint outside the frozen zone, premises excluded", () => {
    expect(freezableConstraints(graphOf(), { anchors: [], frozen: [E5] }).map((n) => n.id)).toEqual(
      [B2, Z9],
    );
  });

  it("offers all constraints when nothing is frozen", () => {
    expect(freezableConstraints(graphOf(), { anchors: [], frozen: [] }).map((n) => n.id)).toEqual([
      A1,
      B2,
      D4,
      E5,
      Z9,
    ]);
  });
});

describe("frozenDependents", () => {
  it("reports frozen constraints within the dependents closure of the targets", () => {
    const ctx: AuthorizationContext = { anchors: [], frozen: [E5, Z9] };
    expect(frozenDependents(graphOf(), ctx, [D4]).map((n) => n.node.id)).toEqual([E5]);
  });

  it("deduplicates frozen nodes hit through several targets", () => {
    const ctx: AuthorizationContext = { anchors: [], frozen: [B2] };
    // B2's frozen closure {B2, E5, D4, A1} intersects the targets' dependents.
    expect(frozenDependents(graphOf(), ctx, [A1, D4]).map((n) => n.node.id)).toEqual([B2, D4, E5]);
  });

  it("returns nothing when the frozen zone is outside the closure", () => {
    const ctx: AuthorizationContext = { anchors: [], frozen: [Z9] };
    expect(frozenDependents(graphOf(), ctx, [D4])).toEqual([]);
  });
});
