import { describe, expect, it } from "vitest";
import { layeredLayout, layeredStrategy } from "../src/graph/layout/engine";
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
    expect(layoutModes).toEqual(["layered", "force"]);
  });

  it("dispatches by mode", () => {
    expect(layoutStrategy("layered").id).toBe("layered");
    expect(layoutStrategy("force").id).toBe("force");
    const session = createLayoutSession("force", chain(2), { direction: "LR" });
    expect(session.animating).toBe(true);
    session.dispose();
  });
});
