import { describe, expect, it } from "vitest";
import { buildGraph } from "refino";
import type { Graph, NodeType, RefinoNode } from "refino";
import {
  applyAuthorization,
  authorizationContextOf,
  convergeAuthorization,
  materializeDefaultAuthorization,
  parseSignedAuthorization,
} from "../src/authorization.js";

function node(id: string, type: NodeType, grounds?: string[]): RefinoNode {
  if (type === "premise") return { id, type: "premise", summary: "Body." };
  return { id, type: "constraint", summary: "Body.", grounds: grounds ?? [] };
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
  return buildGraph([
    node(P1, "premise"),
    node(A1, "constraint"),
    node(D4, "constraint", [A1]),
    node(E5, "constraint", [P1, D4]),
    node(B2, "constraint", [E5]),
    node(Z9, "constraint"),
  ]);
}

const NOW = new Date("2026-09-06T08:30:00Z");

describe("parseSignedAuthorization", () => {
  it("accepts a well-shaped document", () => {
    const doc = parseSignedAuthorization({
      version: 1,
      signedAt: "2026-09-06T08:30:00.000Z",
      revision: 2,
      anchors: [P1],
      frozenFrontier: [E5],
    });
    expect(doc).toEqual({
      version: 1,
      signedAt: "2026-09-06T08:30:00.000Z",
      revision: 2,
      anchors: [P1],
      frozenFrontier: [E5],
    });
  });

  it.each([
    ["null", null],
    [
      "wrong version",
      {
        version: 2,
        signedAt: "2026-09-06T08:30:00.000Z",
        revision: 0,
        anchors: [],
        frozenFrontier: [],
      },
    ],
    [
      "bad timestamp",
      { version: 1, signedAt: "yesterday", revision: 0, anchors: [], frozenFrontier: [] },
    ],
    [
      "negative revision",
      {
        version: 1,
        signedAt: "2026-09-06T08:30:00.000Z",
        revision: -1,
        anchors: [],
        frozenFrontier: [],
      },
    ],
    [
      "non-array anchors",
      {
        version: 1,
        signedAt: "2026-09-06T08:30:00.000Z",
        revision: 0,
        anchors: "A1",
        frozenFrontier: [],
      },
    ],
  ])("rejects %s", (_name, value) => {
    expect(() => parseSignedAuthorization(value)).toThrow(
      expect.objectContaining({ code: "INVALID_AUTHORIZATION" }) as unknown as Error,
    );
  });
});

describe("materializeDefaultAuthorization", () => {
  it("names all root constraints as the frontier and all nodes as anchors", () => {
    const doc = materializeDefaultAuthorization(graphOf(), NOW);
    expect(doc).toEqual({
      version: 1,
      signedAt: "2026-09-06T08:30:00.000Z",
      revision: 0,
      anchors: [P1, A1, B2, D4, E5, Z9],
      frozenFrontier: [A1, Z9],
    });
  });

  it("leaves anchors empty beyond the auto-anchor budget", () => {
    const doc = materializeDefaultAuthorization(graphOf(), NOW, 3);
    expect(doc.anchors).toEqual([]);
    expect(doc.frozenFrontier).toEqual([A1, Z9]);
  });
});

describe("convergeAuthorization", () => {
  it("drops entries whose nodes were deleted", () => {
    // Delete Z9 and E5 from the fixture: both frontier entries vanish and the
    // zone with them — nothing anchors it anymore.
    const graph = buildGraph([
      node(P1, "premise"),
      node(A1, "constraint"),
      node(D4, "constraint", [A1]),
    ]);
    const doc = parseSignedAuthorization({
      version: 1,
      signedAt: "2026-09-06T08:30:00.000Z",
      revision: 1,
      anchors: [P1, E5, Z9],
      frozenFrontier: [E5, Z9],
    });
    expect(convergeAuthorization(graph, doc)).toEqual({
      version: 1,
      signedAt: "2026-09-06T08:30:00.000Z",
      revision: 1,
      anchors: [P1],
      frozenFrontier: [],
    });
  });

  it("reduces the frontier when the graph made a signed entry redundant", () => {
    // Signed [D4, Z9] while both were roots; later D4 was re-grounded on Z9
    // (git edit), so Z9 is now an ancestor inside D4's zone and no longer
    // part of the zone's minimal representation.
    const doc = parseSignedAuthorization({
      version: 1,
      signedAt: "2026-09-06T08:30:00.000Z",
      revision: 1,
      anchors: [],
      frozenFrontier: [D4, Z9],
    });
    const graph = buildGraph([
      node(P1, "premise"),
      node(A1, "constraint"),
      node(D4, "constraint", [A1, Z9]),
      node(Z9, "constraint"),
    ]);
    expect(convergeAuthorization(graph, doc).frozenFrontier).toEqual([D4]);
  });

  it("keeps an already-converged document intact", () => {
    const doc = parseSignedAuthorization({
      version: 1,
      signedAt: "2026-09-06T08:30:00.000Z",
      revision: 1,
      anchors: [A1],
      frozenFrontier: [Z9],
    });
    expect(convergeAuthorization(graphOf(), doc)).toEqual(doc);
  });
});

describe("applyAuthorization", () => {
  it("signs strictly: unknown ids, premise frontiers and duplicates are rejected", () => {
    const graph = graphOf();
    expect(() =>
      applyAuthorization(
        graph,
        { anchors: ["9M8N7P6Q"], frozenFrontier: [] },
        { now: NOW, revision: 1 },
      ),
    ).toThrow(expect.objectContaining({ code: "UNKNOWN_NODE" }) as unknown as Error);
    expect(() =>
      applyAuthorization(graph, { anchors: [], frozenFrontier: [P1] }, { now: NOW, revision: 1 }),
    ).toThrow(expect.objectContaining({ code: "FROZEN_NOT_CONSTRAINT" }) as unknown as Error);
    expect(() =>
      applyAuthorization(
        graph,
        { anchors: [A1, A1], frozenFrontier: [] },
        { now: NOW, revision: 1 },
      ),
    ).toThrow(expect.objectContaining({ code: "DUPLICATE_CONTEXT_ID" }) as unknown as Error);
  });

  it("reduces the frontier to its minimal representation and reports it", () => {
    const { doc, preview } = applyAuthorization(
      graphOf(),
      { anchors: [], frozenFrontier: [A1, D4, E5] },
      { now: NOW, revision: 3 },
    );
    // A1 and D4 are ancestors of E5; only E5 survives.
    expect(doc.frozenFrontier).toEqual([E5]);
    expect(doc.revision).toBe(3);
    expect(doc.signedAt).toBe("2026-09-06T08:30:00.000Z");
    expect(preview.redundantFrontier).toEqual([A1, D4]);
  });

  it("counts the frozen zone and warns about unfrozen roots", () => {
    const { preview } = applyAuthorization(
      graphOf(),
      { anchors: [], frozenFrontier: [E5] },
      { now: NOW, revision: 1 },
    );
    // Zone of E5: E5, D4, A1, P1 — Z9 stays outside and is a root.
    expect(preview).toEqual({
      frozenConstraints: 3,
      frozenPremises: 1,
      unfrozenRoots: [Z9],
      redundantFrontier: [],
    });
  });

  it("produces a context the zone helpers accept", () => {
    const { doc } = applyAuthorization(
      graphOf(),
      { anchors: [P1], frozenFrontier: [E5] },
      { now: NOW, revision: 1 },
    );
    expect(authorizationContextOf(doc)).toEqual({ anchors: [P1], frozen: [E5] });
  });
});
