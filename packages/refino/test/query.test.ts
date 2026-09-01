import { beforeAll, describe, expect, it } from "vitest";
import { loadGraph } from "../src/loader.js";
import { getAncestors, getDependents, getGrounds, RefinoError } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { constraint, createRefino, premise } from "./helpers.js";

/**
 * Fixture shape:
 *   1A2B3C4D ──┐
 *   A1B2C3D4 ──┴→ D4E5F6G7 → E5F6G7H8
 */
let graph: Graph;

beforeAll(async () => {
  const root = await createRefino({
    "premises/1A2B3C4D.md": premise("1A2B3C4D"),
    "constraints/A1B2C3D4.md": constraint("A1B2C3D4", undefined),
    "constraints/D4E5F6G7.md": constraint("D4E5F6G7", ["A1B2C3D4"]),
    "constraints/E5F6G7H8.md": constraint("E5F6G7H8", ["1A2B3C4D", "D4E5F6G7"]),
  });
  graph = (await loadGraph(`${root}/.refino`)).graph;
  // keep the temp dir until the process exits; test temp dirs are disposable
});

function ids(results: ReadonlyArray<{ id: string; node?: { id: string } }>): string[] {
  return results.map((r) => r.node?.id ?? r.id);
}

describe("queries", () => {
  it("grounds are resolved in declared order", () => {
    expect(ids(getGrounds(graph, "E5F6G7H8"))).toEqual(["1A2B3C4D", "D4E5F6G7"]);
    expect(getGrounds(graph, "A1B2C3D4")).toEqual([]);
    expect(getGrounds(graph, "1A2B3C4D")).toEqual([]);
  });

  it("ancestors cover premises and upstream constraints with minimal depth", () => {
    const ancestors = getAncestors(graph, "E5F6G7H8");
    expect(ancestors.map((a) => [a.node.id, a.depth])).toEqual([
      ["1A2B3C4D", 1],
      ["D4E5F6G7", 1],
      ["A1B2C3D4", 2],
    ]);
  });

  it("ancestors of a premise are empty", () => {
    expect(getAncestors(graph, "1A2B3C4D")).toEqual([]);
  });

  it("dependents are the transitive closure of downstream constraints", () => {
    expect(getDependents(graph, "A1B2C3D4").map((d) => [d.node.id, d.depth])).toEqual([
      ["D4E5F6G7", 1],
      ["E5F6G7H8", 2],
    ]);
    expect(getDependents(graph, "1A2B3C4D").map((d) => d.node.id)).toEqual(["E5F6G7H8"]);
    expect(getDependents(graph, "E5F6G7H8")).toEqual([]);
  });

  it("queries on unknown nodes throw NODE_NOT_FOUND", () => {
    for (const query of [
      () => getGrounds(graph, "9M8N7P6Q"),
      () => getAncestors(graph, "9M8N7P6Q"),
      () => getDependents(graph, "9M8N7P6Q"),
    ]) {
      expect(query).toThrow(RefinoError);
      expect(query).toThrow(
        expect.objectContaining({ code: "NODE_NOT_FOUND" }) as unknown as Error,
      );
    }
  });
});
