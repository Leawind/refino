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
  it("registers one entry per edge control at its corner", () => {
    expect(canvasFloats).toHaveLength(7);
    expect(canvasFloats.map((f) => f.placement)).toEqual([
      "top-left",
      "top-right",
      "bottom-right",
      "bottom-right",
      "bottom-right",
      "bottom-right",
      "bottom-left",
    ]);
    for (const float of canvasFloats) {
      expect(float.component).toBeDefined();
    }
  });

  it("renders one float layer per corner with its controls in order", () => {
    const wrapper = mountFloats();
    // All four corners in use now.
    const floats = wrapper.findAll(".graph-float");
    expect(floats).toHaveLength(4);
    // The selection list stays hidden while the selection is empty; the
    // minimap renders its map in the top-left (shown by default). Document
    // queries: GraphFloats's root is a fragment, which VTU's scoped find
    // does not descend into reliably.
    expect(wrapper.find(".graph-float.top-right").element.children).toHaveLength(0);
    expect(document.querySelector(".graph-float.top-left .minimap .map")).not.toBeNull();
    expect(document.querySelectorAll(".graph-float.bottom-right > *")).toHaveLength(4);
    // The bottom-left float carries the status pill.
    expect(document.querySelector(".graph-float.bottom-left .status-pill")).not.toBeNull();
  });
});
