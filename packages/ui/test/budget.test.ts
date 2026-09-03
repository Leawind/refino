import { describe, expect, it } from "vitest";
import {
  COST_EDGE,
  COST_SHAPE_NODE,
  COST_TEXT_NODE,
  createAdaptiveBudget,
  cullByBudget,
  CULL_FOCUS,
  CULL_GROUND_OF_HOVERED,
  CULL_GROUND_OF_SELECTED,
  CULL_HOVERED,
  CULL_OTHER,
  CULL_SELECTED,
  estimateBudget,
  hardwareFactor,
  MIN_BUDGET,
  type CullEntry,
} from "../src/graph/render/budget";
import { ellipsize } from "../src/graph/render/atlas";

describe("budget estimation", () => {
  it("scales with viewport area and the hardware factor, clamped", () => {
    const small = estimateBudget({ width: 800, height: 600 }, 1);
    const large = estimateBudget({ width: 1600, height: 1200 }, 1);
    expect(large).toBeGreaterThan(small);
    expect(small).toBeGreaterThanOrEqual(MIN_BUDGET);

    // A stronger machine budgets more; an empty viewport falls back to the floor.
    expect(estimateBudget({ width: 800, height: 600 }, 2)).toBeGreaterThan(small);
    expect(estimateBudget({ width: 0, height: 0 }, 1)).toBe(MIN_BUDGET);
  });

  it("maps logical cores onto a bounded factor", () => {
    expect(hardwareFactor(16)).toBeGreaterThan(hardwareFactor(4));
    expect(hardwareFactor(256)).toBeLessThanOrEqual(3);
    expect(hardwareFactor(1)).toBeGreaterThanOrEqual(0.5);
  });
});

describe("adaptive budget", () => {
  it("pins manual mode regardless of frame times", () => {
    const budget = createAdaptiveBudget(
      { mode: "manual", manualBudget: 500 },
      { width: 800, height: 600 },
      1,
    );
    for (let i = 0; i < 100; i++) budget.reportFrame(80);
    expect(budget.current()).toBe(500);
  });

  it("shrinks when frames run long and grows back within the estimate", () => {
    const budget = createAdaptiveBudget(
      { mode: "auto", manualBudget: 0 },
      { width: 800, height: 600 },
      1,
    );
    const initial = budget.current();

    // Sustained ~33fps: the budget contracts after warmup, in steps.
    for (let i = 0; i < 8; i++) budget.reportFrame(50);
    const shrunk = budget.current();
    expect(shrunk).toBeLessThan(initial);

    // Sustained 90fps: it grows back, never beyond the initial estimate.
    for (let i = 0; i < 500; i++) budget.reportFrame(11);
    expect(budget.current()).toBe(initial);

    // Re-estimating a bigger viewport raises the ceiling again.
    budget.reestimate({ width: 3200, height: 2400 });
    expect(budget.current()).toBeGreaterThan(initial);
  });
});

describe("budget culling", () => {
  const entry = (id: string, cls: number, distance = 0, cost = COST_SHAPE_NODE): CullEntry => ({
    id,
    cls,
    distance,
    cost,
  });

  it("keeps the priority order focus, selected, hovered, grounds, then distance", () => {
    const entries: CullEntry[] = [
      entry("far-other", CULL_OTHER, 100),
      entry("near-other", CULL_OTHER, 1),
      entry("ground-hover", CULL_GROUND_OF_HOVERED, 0),
      entry("ground-selected", CULL_GROUND_OF_SELECTED, 0),
      entry("hovered", CULL_HOVERED),
      entry("selected", CULL_SELECTED),
      entry("focus", CULL_FOCUS, 0, COST_TEXT_NODE),
    ];
    // Room for exactly the text-cost focus and one more shape node.
    const result = cullByBudget(entries, [], COST_TEXT_NODE + COST_SHAPE_NODE);
    expect(result.admitted).toEqual(new Set(["focus", "selected"]));
    expect(result.culled).toBe(true);
  });

  it("orders same-class nodes by distance, then id", () => {
    const entries: CullEntry[] = [
      entry("b-near", CULL_OTHER, 5),
      entry("a-far", CULL_OTHER, 9),
      entry("a-near", CULL_OTHER, 5),
    ];
    const result = cullByBudget(entries, [], COST_SHAPE_NODE * 2);
    expect([...result.admitted]).toEqual(["a-near", "b-near"]);
  });

  it("only lights an edge once both endpoints fit the budget", () => {
    const entries: CullEntry[] = [
      entry("focus", CULL_FOCUS),
      entry("other", CULL_OTHER, 10),
      entry("poor", CULL_OTHER, 20),
    ];
    const edges = [
      { fromId: "focus", toId: "other" },
      { fromId: "other", toId: "poor" },
    ];
    // Focus fits alone; the focus→other edge would overflow, so "other" is
    // skipped and the unconnected "poor" gets its slot instead.
    const tight = cullByBudget(entries, edges, COST_SHAPE_NODE * 2);
    expect(tight.admitted).toEqual(new Set(["focus", "poor"]));
    expect(tight.edges.size).toBe(0);

    // One more cost unit admits "other" together with its edge.
    const enough = cullByBudget(entries, edges, COST_SHAPE_NODE * 2 + COST_EDGE);
    expect(enough.admitted).toEqual(new Set(["focus", "other"]));
    expect([...enough.edges]).toEqual(["focus\u0000other"]);
  });

  it("skips a node whose edges would overflow and admits cheaper ones", () => {
    const entries: CullEntry[] = [
      entry("focus", CULL_FOCUS, 0, COST_TEXT_NODE),
      entry("hub", CULL_OTHER, 1, COST_TEXT_NODE), // lights two edges
      entry("leaf-a", CULL_OTHER, 2, COST_SHAPE_NODE),
      entry("leaf-b", CULL_OTHER, 3, COST_SHAPE_NODE),
    ];
    const edges = [
      { fromId: "leaf-a", toId: "hub" },
      { fromId: "leaf-b", toId: "hub" },
    ];
    // Focus + hub + one leaf with its edge fit; the second leaf's edge
    // would overflow and the leaf is skipped with it.
    const budget = COST_TEXT_NODE * 2 + COST_SHAPE_NODE + COST_EDGE;
    const result = cullByBudget(entries, edges, budget);
    expect(result.admitted).toEqual(new Set(["focus", "hub", "leaf-a"]));
    expect(result.edges).toEqual(new Set(["leaf-a\u0000hub"]));
    expect(result.culled).toBe(true);
  });
});

describe("label truncation", () => {
  // jsdom canvas has no 2D context; measure with a stub via a cast.
  const atlas = {
    measure: (text: string) => [...text].reduce((sum, ch) => sum + (ch === "短" ? 6 : 10), 0),
  } as unknown as Parameters<typeof ellipsize>[0];

  it("keeps text that fits and ellipsizes the rest", () => {
    expect(ellipsize(atlas, "短", 20)).toBe("短");
    const fitted = ellipsize(atlas, "长长长长长长", 35);
    expect(fitted.endsWith("…")).toBe(true);
    expect(atlas.measure(fitted)).toBeLessThanOrEqual(35);
    expect(ellipsize(atlas, "长长长长长长", 5)).toBe("…");
  });
});
