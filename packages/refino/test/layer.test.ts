import { describe, expect, it } from "vitest";
import { assignLayers } from "../src/layer.js";
import type { LayerNode } from "../src/layer.js";

function node(id: string, grounds: string[] = []): LayerNode {
  return { id, grounds };
}

describe("assignLayers", () => {
  it("puts sources at layer 0 and follows the longest path", () => {
    const layers = assignLayers([
      node("A"),
      node("B", ["A"]),
      node("C", ["A"]),
      node("D", ["B", "C"]),
      node("E", ["D"]),
    ]);
    expect(layers.get("A")).toBe(0);
    expect(layers.get("B")).toBe(1);
    expect(layers.get("C")).toBe(1);
    expect(layers.get("D")).toBe(2);
    expect(layers.get("E")).toBe(3);
  });

  it("takes the maximum over multiple grounds chains", () => {
    const layers = assignLayers([
      node("A"),
      node("B", ["A"]),
      node("C", ["A"]),
      node("D", ["C"]),
      node("E", ["B", "D"]),
    ]);
    expect(layers.get("E")).toBe(3);
  });

  it("lays out disjoint components independently", () => {
    const layers = assignLayers([node("A"), node("B", ["A"]), node("C"), node("D", ["C"])]);
    expect(layers.get("B")).toBe(1);
    expect(layers.get("C")).toBe(0);
    expect(layers.get("D")).toBe(1);
  });

  it("ignores grounds pointing outside the set", () => {
    const layers = assignLayers([node("A", ["GHOST"]), node("B", ["A", "GHOST"])]);
    expect(layers.get("A")).toBe(0);
    expect(layers.get("B")).toBe(1);
  });

  it("assigns a layer to every node on a cycle", () => {
    const layers = assignLayers([
      node("A", ["C"]),
      node("B", ["A"]),
      node("C", ["B"]),
      node("D", ["A"]),
    ]);
    expect(layers.size).toBe(4);
    for (const layer of layers.values()) expect(Number.isInteger(layer)).toBe(true);
    // Downstream of the cycle still lands past it.
    expect(layers.get("D")).toBeGreaterThan(layers.get("A")!);
  });

  it("is independent of input order", () => {
    const forward = [node("A"), node("B", ["A"]), node("C", ["B"]), node("D", ["B", "C"])];
    const backward = [...forward].reverse();
    expect([...assignLayers(backward)]).toEqual([...assignLayers(forward)]);
  });

  it("handles empty and self-referencing inputs", () => {
    expect(assignLayers([]).size).toBe(0);
    const layers = assignLayers([node("A", ["A"])]);
    expect(layers.get("A")).toBe(0);
  });
});
