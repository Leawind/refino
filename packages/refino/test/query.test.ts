import { beforeAll, describe, expect, it } from "vitest";
import { loadGraph } from "../src/loader.js";
import { getAncestors, getDependents, getGrounds, getImpact, RefinoError } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { constraint, createRefino, premise } from "./helpers.js";

/**
 * Fixture shape:
 *   P-003 ──┐
 *   C-001 ──┴→ C-007 → C-019
 */
let graph: Graph;

beforeAll(async () => {
  const root = await createRefino({
    "premises/P-003.md": premise("P-003"),
    "constraints/C-001.md": constraint("C-001", undefined),
    "constraints/C-007.md": constraint("C-007", ["C-001"]),
    "constraints/C-019.md": constraint("C-019", ["P-003", "C-007"]),
  });
  graph = (await loadGraph(`${root}/.refino`)).graph;
  // keep the temp dir until the process exits; test temp dirs are disposable
});

function ids(results: ReadonlyArray<{ id: string; node?: { id: string } }>): string[] {
  return results.map((r) => r.node?.id ?? r.id);
}

describe("queries", () => {
  it("grounds are resolved in declared order", () => {
    expect(ids(getGrounds(graph, "C-019"))).toEqual(["P-003", "C-007"]);
    expect(getGrounds(graph, "C-001")).toEqual([]);
    expect(getGrounds(graph, "P-003")).toEqual([]);
  });

  it("ancestors cover premises and upstream constraints with minimal depth", () => {
    const ancestors = getAncestors(graph, "C-019");
    expect(ancestors.map((a) => [a.node.id, a.depth])).toEqual([
      ["C-007", 1],
      ["P-003", 1],
      ["C-001", 2],
    ]);
  });

  it("ancestors of a premise are empty", () => {
    expect(getAncestors(graph, "P-003")).toEqual([]);
  });

  it("dependents are the transitive closure of downstream constraints", () => {
    expect(getDependents(graph, "C-001").map((d) => [d.node.id, d.depth])).toEqual([
      ["C-007", 1],
      ["C-019", 2],
    ]);
    expect(getDependents(graph, "P-003").map((d) => d.node.id)).toEqual(["C-019"]);
    expect(getDependents(graph, "C-019")).toEqual([]);
  });

  it("impact is the impact set of a node (same as dependents)", () => {
    expect(getImpact(graph, "C-001")).toEqual(getDependents(graph, "C-001"));
  });

  it("queries on unknown nodes throw NODE_NOT_FOUND", () => {
    for (const query of [
      () => getGrounds(graph, "X-001"),
      () => getAncestors(graph, "X-001"),
      () => getDependents(graph, "X-001"),
      () => getImpact(graph, "X-001"),
    ]) {
      expect(query).toThrow(RefinoError);
      expect(query).toThrow(
        expect.objectContaining({ code: "NODE_NOT_FOUND" }) as unknown as Error,
      );
    }
  });
});
