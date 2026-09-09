// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { canvasFloats } from "../src/canvasFloats";
import GraphFloats from "../src/components/GraphFloats.vue";
import { createRefinoI18n } from "../src/i18n";
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
  const workspace = createWorkspace(fakeClient());
  return mount(GraphFloats, {
    global: {
      provide: { [workspaceKey as symbol]: workspace },
      plugins: [createRefinoI18n("zh")],
    },
  });
}

beforeEach(() => {
  localStorage.clear();
});

describe("canvas floats manifest", () => {
  it("registers one entry per edge control at its corner", () => {
    expect(canvasFloats).toHaveLength(5);
    expect(canvasFloats.map((f) => f.placement)).toEqual([
      "top-right",
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
    // Three corners in use; the top-left group is empty and renders none.
    const floats = wrapper.findAll(".graph-float");
    expect(floats).toHaveLength(3);
    // The selection list stays hidden while the selection is empty.
    expect(wrapper.find(".graph-float.top-right").element.children).toHaveLength(0);
    expect(wrapper.find(".graph-float.bottom-right").element.children).toHaveLength(3);
    // The bottom-left float carries the status pill.
    expect(wrapper.find(".graph-float.bottom-left .status-pill").exists()).toBe(true);
  });
});
