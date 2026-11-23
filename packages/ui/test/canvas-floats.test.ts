// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { canvasFloats } from "../src/canvasFloats";
import GraphFloats from "../src/components/GraphFloats.vue";
import { createRefinoI18n } from "../src/i18n";
import { setViewportCommands } from "../src/viewportBridge";
import { createStore, storeKey } from "../src/store";
import { createWorkspace, workspaceKey } from "../src/workspace";
import type { RefinoClient } from "../src/api";

/**
 * The canvas edge float manifest (ui DESIGN.md, "布局"): a static registry
 * of { corner, component } entries walked by a single renderer. The tests
 * pin the manifest shape and prove the renderer wires every control into
 * its corner float.
 */

/** A client that never gets called: mounting the floats touches no data. */
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

function mountFloats() {
  const client = fakeClient();
  const workspace = createWorkspace(client);
  const store = createStore(client, workspace);
  return mount(GraphFloats, {
    global: {
      provide: {
        [workspaceKey as symbol]: workspace,
        [storeKey as symbol]: store,
      },
      plugins: [createRefinoI18n("zh")],
    },
    attachTo: document.body,
  });
}

beforeEach(() => {
  localStorage.clear();
  // The zoom controls and the minimap render inert without a canvas.
  setViewportCommands({
    zoomBy: vi.fn(),
    fitView: vi.fn(),
    fitSelection: vi.fn(),
    centerOn: vi.fn(),
    getOverview: () => null,
    onCameraChanged: () => () => {},
  });
});

describe("canvas floats manifest", () => {
  it("registers one entry per edge control at its edge", () => {
    expect(canvasFloats).toHaveLength(4);
    expect(canvasFloats.map((f) => f.placement)).toEqual([
      "top-left",
      "top-center",
      "bottom-right",
      "bottom-left",
    ]);
    for (const float of canvasFloats) {
      expect(float.component).toBeDefined();
    }
  });

  it("renders one float layer per edge with its controls in order", () => {
    const wrapper = mountFloats();
    // Three edges in use: the minimap, the selection trail and the grouped
    // controls; the status line shares the canvas foot.
    const floats = wrapper.findAll(".graph-float");
    expect(floats).toHaveLength(4);
    expect(document.querySelector(".graph-float.top-left .minimap .map")).not.toBeNull();
    // The trail stays hidden while the selection is empty; its layer is
    // still mounted (the component renders nothing).
    expect(document.querySelector(".graph-float.top-center")?.children).toHaveLength(0);
    // The bottom-right corner is one grouped control laid out along the two
    // edges it touches, so no control floats in the canvas interior.
    expect(document.querySelectorAll(".graph-float.bottom-right > *")).toHaveLength(1);
    expect(document.querySelector(".graph-float.bottom-right .canvas-controls")).not.toBeNull();
    // Square controls stack up the right edge, nearest the corner first.
    const stack = document.querySelector(".graph-float.bottom-right .canvas-controls .stack");
    expect([...(stack?.children ?? [])].map((child) => child.className.split(" ").at(0))).toEqual([
      "node-size",
      "style-settings",
    ]);
    // Wide controls run left along the bottom edge; the view switch keeps the
    // corner itself, last in the strip.
    const strip = document.querySelector(".graph-float.bottom-right .canvas-controls .strip");
    expect([...(strip?.children ?? [])].map((child) => child.className.split(" ").at(-1))).toEqual([
      "layout-controls",
      "zoom-controls",
      "view-toggle",
    ]);
    // The field-of-view control belongs to the orbit view.
    expect(document.querySelector(".graph-float.bottom-right .fov-control")).toBeNull();
    expect(document.querySelector(".graph-float.bottom-left .status")).not.toBeNull();
    wrapper.unmount();
  });

  it("hides the planar-only controls in the orbit view", () => {
    localStorage.setItem("refino.canvas.canvasView", "orbit");
    const wrapper = mountFloats();
    // No minimap, no layout/style/size controls: they only address the
    // planar layout. The view switch, zoom controls and status line stay.
    expect(document.querySelector(".graph-float.top-left")).toBeNull();
    // The selection trail is view-neutral but empty, so its layer stays.
    expect(document.querySelector(".graph-float.top-center")?.children).toHaveLength(0);
    expect(document.querySelectorAll(".graph-float.bottom-right > *")).toHaveLength(1);
    expect(document.querySelector(".graph-float.bottom-right .view-toggle")).not.toBeNull();
    expect(document.querySelector(".graph-float.bottom-right .zoom-controls")).not.toBeNull();
    // The orbit view keeps only its own square control in the right stack.
    const stack = document.querySelector(".graph-float.bottom-right .canvas-controls .stack");
    expect([...(stack?.children ?? [])].map((child) => child.className.split(" ").at(0))).toEqual([
      "fov-control",
    ]);
    const strip = document.querySelector(".graph-float.bottom-right .canvas-controls .strip");
    expect([...(strip?.children ?? [])].map((child) => child.className.split(" ").at(-1))).toEqual([
      "zoom-controls",
      "view-toggle",
    ]);
    expect(document.querySelector(".graph-float.bottom-right .layout-controls")).toBeNull();
    expect(document.querySelector(".graph-float.bottom-right .style-settings")).toBeNull();
    expect(document.querySelector(".graph-float.bottom-left .status")).not.toBeNull();
    wrapper.unmount();
  });
});
