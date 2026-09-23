import { describe, expect, it } from "vitest";
import { layeredLayout, layeredStrategy, NODE_WIDTH } from "../src/graph/layout/engine";
import { createLayoutSession, layoutModes, layoutStrategy } from "../src/graph/layout/registry";
import type { LayoutNode } from "../src/graph/layout/types";

function chain(length: number): LayoutNode[] {
  return Array.from({ length }, (_, i) => ({
    id: `n${i}`,
    grounds: i === 0 ? [] : [`n${i - 1}`],
  }));
}

describe("layered session", () => {
  it("settles at creation and steps never move nodes", () => {
    const session = layeredStrategy.createSession(chain(4), { direction: "LR" });
    expect(session.animating).toBe(false);
    const first = session.step(16);
    const second = session.step(16);
    expect(second).toEqual(first);
    expect(second).toEqual(layeredLayout(chain(4), "LR"));
    session.dispose();
  });

  it("positions() matches the snapshot geometry", () => {
    const session = layeredStrategy.createSession(chain(3), { direction: "TB" });
    expect(session.positions()).toEqual(layeredLayout(chain(3), "TB"));
    session.dispose();
  });
});

describe("layout registry", () => {
  it("lists every selectable mode", () => {
    expect(layoutModes).toEqual(["layered", "force", "rail"]);
  });

  it("dispatches by mode", () => {
    expect(layoutStrategy("layered").id).toBe("layered");
    expect(layoutStrategy("force").id).toBe("force");
    expect(layoutStrategy("rail").id).toBe("rail");
    const session = createLayoutSession("force", chain(2), { direction: "LR" });
    expect(session.animating).toBe(true);
    session.dispose();
  });
});

describe("common layer gap", () => {
  it("spaces adjacent layers at card length plus the configured gap", () => {
    const gap = 200;
    const laid = layeredLayout(chain(4), "LR", undefined, gap);
    const byId = new Map(laid.map((n) => [n.id, n] as const));
    for (let i = 1; i < 4; i++) {
      const a = byId.get(`n${i - 1}`)!;
      const b = byId.get(`n${i}`)!;
      expect(b.x - a.x).toBeCloseTo(NODE_WIDTH + gap, 6);
    }
    // The session wires the option through.
    const session = layeredStrategy.createSession(chain(4), { direction: "LR", layerGap: gap });
    expect(session.positions()).toEqual(laid);
    session.dispose();
  });
});
