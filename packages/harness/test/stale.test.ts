import { describe, expect, it } from "vitest";
import { buildGraph } from "refino";
import type { Graph } from "refino";
import { DEFAULT_STALE_DAYS, staleNodes } from "../src/stale.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-05-01T00:00:00Z");

function graphOf(): Graph {
  return buildGraph([
    {
      id: "R1ROOT",
      type: "decision",
      summary: "根决策",
      grounds: [],
      reviewed: NOW - 120 * DAY,
    },
    {
      id: "C1CHILD",
      type: "decision",
      summary: "子决策",
      grounds: ["R1ROOT"],
      reviewed: NOW - 30 * DAY,
    },
    { id: "D1NEVER", type: "decision", summary: "从未复核", grounds: [] },
    { id: "P1PREMISE", type: "premise", summary: "前提", confirmed: NOW - 200 * DAY },
    { id: "Q1FRESH", type: "premise", summary: "刚确认的前提", confirmed: NOW - DAY },
  ]);
}

describe("staleNodes", () => {
  it("splits overdue from never-reviewed and keeps fresh nodes out", () => {
    const report = staleNodes(graphOf(), NOW);
    expect(report.days).toBe(DEFAULT_STALE_DAYS);
    expect(report.overdue.map((node) => node.id)).toEqual(["P1PREMISE", "R1ROOT"]);
    expect(report.overdue[0]!.age_days).toBe(200);
    expect(report.never.map((node) => node.id)).toEqual(["D1NEVER"]);
    // C1CHILD (30 days) and Q1FRESH (1 day) are inside the threshold.
    expect(report.overdue.map((node) => node.id)).not.toContain("C1CHILD");
  });

  it("orders overdue oldest first and never-reviewed by id", () => {
    const graph = buildGraph([
      { id: "B1BBBB", type: "decision", summary: "b", grounds: [] },
      { id: "A1AAAA", type: "decision", summary: "a", grounds: [] },
      { id: "B2SECOND", type: "decision", summary: "c", grounds: [] },
    ] as never);
    const report = staleNodes(graph, NOW, 0);
    expect(report.never.map((node) => node.id)).toEqual(["A1AAAA", "B1BBBB", "B2SECOND"]);
  });

  it("honors a custom threshold", () => {
    const report = staleNodes(graphOf(), NOW, 365);
    expect(report.overdue).toEqual([]);
    expect(report.never.map((node) => node.id)).toEqual(["D1NEVER"]);
  });

  it("treats the threshold as strictly exceeded", () => {
    const graph = buildGraph([
      { id: "R1ROOT", type: "decision", summary: "r", grounds: [], reviewed: NOW - 90 * DAY },
    ]);
    expect(staleNodes(graph, NOW, 90).overdue).toEqual([]);
    expect(staleNodes(graph, NOW, 89).overdue.map((node) => node.id)).toEqual(["R1ROOT"]);
  });
});
