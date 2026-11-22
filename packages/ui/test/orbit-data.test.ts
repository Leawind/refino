import { describe, expect, it } from "vitest";
import {
  buildOrbitScene,
  DECISION_SATELLITE_RADIUS,
  orbitRingBasis,
  ROOT_SATELLITE_RADIUS,
} from "../src/graph/orbit/data";
import type { NodeLite } from "../src/types";

/** Orbit scene data (ui DESIGN.md, "三维视图"): decisions fill the lineage
 * shells, premises orbit the decisions they ground as satellites, and the
 * edges only connect decisions. */

const decision = (id: string, grounds?: string[]): NodeLite => ({
  id,
  type: "decision",
  summary: id,
  grounds,
});
const premise = (id: string): NodeLite => ({ id, type: "premise", summary: id });

const dot = (
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
): number => left.x * right.x + left.y * right.y + left.z * right.z;

describe("buildOrbitScene", () => {
  it("lays out decisions only; premises become satellites", () => {
    const scene = buildOrbitScene([premise("P1"), decision("A", ["P1"]), decision("B", ["A"])]);
    expect(scene.nodes.map((node) => node.id).sort()).toEqual(["A", "B"]);
    expect(scene.nodes.find((node) => node.id === "B")?.depth).toBe(2);
    for (const node of scene.nodes) {
      expect(Number.isFinite(node.x + node.y + node.z)).toBe(true);
    }
    expect(scene.satellites).toHaveLength(1);
    expect(scene.satellites[0]).toMatchObject({ id: "P1", host: "A" });
    expect(scene.radius).toBeGreaterThan(0);
  });

  it("gives a shared premise one satellite per consumer decision", () => {
    const scene = buildOrbitScene([premise("P1"), decision("A", ["P1"]), decision("B", ["P1"])]);
    const copies = scene.satellites.filter((satellite) => satellite.id === "P1");
    expect(copies).toHaveLength(2);
    expect(new Set(copies.map((copy) => copy.key)).size).toBe(2);
    expect(copies.map((copy) => copy.host).sort()).toEqual(["A", "B"]);
  });

  it("orbits unreferenced premises around the virtual root", () => {
    const scene = buildOrbitScene([premise("ORPHAN"), decision("A")]);
    expect(scene.satellites).toEqual([
      expect.objectContaining({ id: "ORPHAN", host: null, radius: ROOT_SATELLITE_RADIUS }),
    ]);
  });

  it("gives every satellite of one host its own tilted ring", () => {
    const scene = buildOrbitScene([premise("P1"), premise("P2"), decision("A", ["P1", "P2"])]);
    const [first, second] = scene.satellites;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    expect(first.radius).toBe(DECISION_SATELLITE_RADIUS);
    // Every satellite of one host takes its own radius, so the tracks never
    // coincide.
    expect(second.radius).toBeGreaterThan(first.radius);
    for (const satellite of [first, second]) {
      expect(Math.hypot(satellite.axisA.x, satellite.axisA.y, satellite.axisA.z)).toBeCloseTo(1, 6);
      expect(Math.hypot(satellite.axisB.x, satellite.axisB.y, satellite.axisB.z)).toBeCloseTo(1, 6);
      expect(dot(satellite.axisA, satellite.axisB)).toBeCloseTo(0, 6);
    }
    // And its own plane: two premise orbits around one decision are never
    // coplanar.
    expect(second.axisA).not.toEqual(first.axisA);
    const gap = Math.abs(second.phase - first.phase);
    expect(gap).toBeCloseTo(Math.PI, 6);
  });

  it("keeps edges between decisions and drops grounds outside the working set", () => {
    const scene = buildOrbitScene([
      premise("P1"),
      decision("A", ["P1", "MISSING"]),
      decision("B", ["A"]),
    ]);
    expect(scene.edges).toEqual([{ from: "A", to: "B", primary: true }]);
  });

  it("changes the signature when the displayed structure changes", () => {
    const before = buildOrbitScene([decision("A"), decision("B", ["A"])]);
    const after = buildOrbitScene([decision("A"), decision("B")]);
    expect(after.signature).not.toBe(before.signature);
  });
});

describe("orbitRingBasis", () => {
  it("is deterministic and orthonormal", () => {
    const first = orbitRingBasis("A");
    const again = orbitRingBasis("A");
    expect(again).toEqual(first);
    expect(dot(first.axisA, first.axisB)).toBeCloseTo(0, 6);
    expect(Math.hypot(first.axisA.x, first.axisA.y, first.axisA.z)).toBeCloseTo(1, 6);
    expect(orbitRingBasis("B")).not.toEqual(first);
  });
});
