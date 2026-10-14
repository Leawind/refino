// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { clientKey } from "../src/api";
import type { RefinoClient } from "../src/api";
import CanvasMinimap from "../src/components/CanvasMinimap.vue";
import { createRefinoI18n } from "../src/i18n";
import { setViewportCommands } from "../src/viewportBridge";
import { createStore, storeKey } from "../src/store";
import { createWorkspace, workspaceKey } from "../src/workspace";
import type { OverviewSnapshot } from "../src/graph/render/overview";
import type { Workspace } from "../src/workspace";

/**
 * The minimap (ui DESIGN.md, "视口"): navigation rides the viewport bridge
 * (click/drag centers the viewport, the wheel zooms) and the collapse
 * toggle persists in the canvas config. jsdom has no 2D canvas context, so
 * the drawing path stays unexercised here — the projection math has its
 * own suite (overview.test.ts).
 */

const handlers = {
  zoomBy: vi.fn(),
  fitView: vi.fn(),
  fitSelection: vi.fn(),
  centerOn: vi.fn(),
  getOverview: vi.fn((): OverviewSnapshot | null => ({
    nodes: [{ x: 0, y: 0, width: 100, height: 40, premise: false }],
    camera: { scale: 1, tx: -200, ty: -100 },
    viewport: { width: 400, height: 300 },
  })),
  onCameraChanged: vi.fn(() => () => {}),
};

let workspace: Workspace;
const wrappers: Array<ReturnType<typeof mount>> = [];

function mountMinimap() {
  const client = fakeClient();
  const store = createStore(client, workspace);
  const wrapper = mount(CanvasMinimap, {
    global: {
      provide: {
        [workspaceKey as symbol]: workspace,
        [storeKey as symbol]: store,
        [clientKey as symbol]: client,
      },
      plugins: [createRefinoI18n("zh")],
    },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  return wrapper;
}

function fakeClient(): RefinoClient {
  return {
    queryNeighbors: async () => [],
    queryExpand: async () => [],
    queryRange: async () => ({ mode: "disconnected", nodes: [] }),
    queryGrounds: async () => [],
    search: async () => ({ nodes: [] }),
    fetchNode: async () => {
      throw new Error("not used");
    },
    fetchIssues: async () => ({ ok: true, issues: [], revision: 0 }),
    reloadGraph: async () => ({ revision: 0, changed: [], deleted: [] }),
    createNode: async () => {
      throw new Error("not used");
    },
    updateNode: async () => {
      throw new Error("not used");
    },
    deleteNode: async () => {
      throw new Error("not used");
    },
    connectEvents: () => () => {},
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  workspace = createWorkspace(fakeClient());
  setViewportCommands(handlers as never);
});

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount();
  setViewportCommands(null);
  workspace.stop();
});

describe("CanvasMinimap", () => {
  it("renders the map and navigates on click", async () => {
    const wrapper = mountMinimap();
    // The first draw runs on the next animation frame; navigation needs
    // its projection.
    await vi.waitFor(() => expect(handlers.getOverview).toHaveBeenCalled());
    expect(wrapper.find(".map").exists()).toBe(true);
    const canvas = wrapper.find(".map");
    // Raw events: VTU's trigger cannot set the read-only clientX/Y.
    canvas.element.dispatchEvent(
      new MouseEvent("pointerdown", { clientX: 100, clientY: 70, bubbles: true }),
    );
    expect(handlers.centerOn).toHaveBeenCalledTimes(1);
    const [vx, vy] = handlers.centerOn.mock.calls[0] as [number, number];
    // Content = nodes [0..100] ∪ viewport [200..600]×[100..400]: a
    // 600×400 box mapped into the 184×124 inner area (width binds); the
    // click at the map's halfway point lands on the content center.
    expect(vx).toBeCloseTo(300, 0);
    expect(vy).toBeCloseTo(200, 0);
    canvas.element.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true }),
    );
    expect(handlers.zoomBy).toHaveBeenCalled();
  });

  it("collapses to a restorer button and persists the preference", async () => {
    const wrapper = mountMinimap();
    await wrapper.find(".head").trigger("click");
    expect(workspace.state.config.showMinimap).toBe(false);
    expect(localStorage.getItem("refino.canvas.showMinimap")).toBe("false");
    await wrapper.find(".restorer").trigger("click");
    expect(workspace.state.config.showMinimap).toBe(true);
  });
});
