import { describe, expect, it } from "vitest";
import {
  layoutOrbit,
  ORBIT_ROOT_STAR_RADIUS,
  type OrbitNodeInput,
  type OrbitPoint,
} from "../src/graph/orbit/layout";

/**
 * Orbit layout (ui DESIGN.md, "三维视图"): the virtual root is the origin and
 * lineage depth maps onto shells; premises are satellites and do not take
 * shell slots. The layout is a pure, deterministic function of the working
 * set.
 */

const decision = (id: string, grounds: string[] = []): OrbitNodeInput => ({
  id,
  grounds,
});

const at = (layout: ReturnType<typeof layoutOrbit>, id: string): OrbitPoint => {
  const point = layout.positions.get(id);
  if (point === undefined) throw new Error(`${id} was not laid out`);
  return point;
};

const distance = (point: OrbitPoint): number => Math.hypot(point.x, point.y, point.z);

describe("radial placement", () => {
  it("leaves the virtual root out and keeps lineage depth as shell order", () => {
    const layout = layoutOrbit([
      decision("R"),
      decision("A", ["R"]),
      decision("B", ["A"]),
      decision("C", ["B"]),
    ]);
    expect(layout.positions.has("R")).toBe(true);
    expect(layout.positions.size).toBe(4);
    expect(distance(at(layout, "R"))).toBeGreaterThan(0);
    expect(distance(at(layout, "A"))).toBeGreaterThan(distance(at(layout, "R")));
    expect(distance(at(layout, "B"))).toBeGreaterThan(distance(at(layout, "A")));
    expect(distance(at(layout, "C"))).toBeGreaterThan(distance(at(layout, "B")));
    for (const point of layout.positions.values()) {
      expect(Number.isFinite(point.x + point.y + point.z)).toBe(true);
    }
  });

  it("places every decision of disconnected branches", () => {
    const layout = layoutOrbit([
      decision("R1"),
      decision("R2"),
      decision("A", ["R1"]),
      decision("B", ["R2"]),
      decision("C", ["A", "B"]),
    ]);
    for (const id of ["R1", "R2", "A", "B", "C"]) {
      expect(layout.positions.has(id)).toBe(true);
    }
  });

  it("is deterministic and independent of input order", () => {
    const nodes = [
      decision("R"),
      decision("A", ["R"]),
      decision("B", ["R"]),
      decision("C", ["A", "B"]),
      decision("D", ["B"]),
    ];
    const forwards = layoutOrbit(nodes);
    const backwards = layoutOrbit([...nodes].reverse());
    for (const id of ["R", "A", "B", "C", "D"]) {
      expect(at(backwards, id)).toEqual(at(forwards, id));
    }
  });

  it("grows a crowded shell instead of piling stars on one spot", () => {
    const nodes: OrbitNodeInput[] = [decision("P")];
    for (let index = 0; index < 120; index++) {
      nodes.push(decision(`N${index.toString().padStart(3, "0")}`, ["P"]));
    }
    const layout = layoutOrbit(nodes);
    const shell = distance(at(layout, "N000"));
    const seen = new Set<string>();
    for (const point of layout.positions.values()) {
      seen.add(`${point.x.toFixed(3)}|${point.y.toFixed(3)}|${point.z.toFixed(3)}`);
    }
    // The shell grew to fit the fan, and every star keeps its own position.
    expect(shell).toBeGreaterThan(5);
    expect(seen.size).toBe(layout.positions.size);
    expect(layout.radius).toBeGreaterThan(shell);
  });

  it("keeps one lineage on a radial filament", () => {
    const layout = layoutOrbit([
      decision("R"),
      decision("A", ["R"]),
      decision("B", ["A"]),
      decision("C", ["B"]),
    ]);
    const angle = (left: OrbitPoint, right: OrbitPoint): number => {
      const dot =
        (left.x * right.x + left.y * right.y + left.z * right.z) /
        (Math.hypot(left.x, left.y, left.z) * Math.hypot(right.x, right.y, right.z));
      return Math.acos(Math.min(1, Math.max(-1, dot)));
    };
    // Each lone child continues almost straight out, so the chain reads as
    // one ray from the root instead of a random walk.
    expect(angle(at(layout, "R"), at(layout, "A"))).toBeLessThan(0.2);
    expect(angle(at(layout, "A"), at(layout, "B"))).toBeLessThan(0.2);
    expect(angle(at(layout, "B"), at(layout, "C"))).toBeLessThan(0.2);
  });

  it("ignores grounds outside the working set and survives cycles", () => {
    const layout = layoutOrbit([
      decision("R", ["missing"]),
      decision("A", ["B"]),
      decision("B", ["A"]),
    ]);
    for (const id of ["R", "A", "B"]) expect(at(layout, id)).toBeDefined();
  });

  it("handles an empty working set", () => {
    const layout = layoutOrbit([]);
    expect(layout.positions.size).toBe(0);
    expect(layout.radius).toBeGreaterThanOrEqual(ORBIT_ROOT_STAR_RADIUS);
  });
});
