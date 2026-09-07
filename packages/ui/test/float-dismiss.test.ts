// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createRefinoI18n } from "../src/i18n";
import CanvasStyleSettings from "../src/components/CanvasStyleSettings.vue";
import NodeSizeControl from "../src/components/NodeSizeControl.vue";
import { createWorkspace, workspaceKey } from "../src/workspace";
import type { Component } from "vue";
import type { RefinoClient } from "../src/api";

/**
 * Unified float panel dismissal (ui DESIGN.md, "布局"): every edge float
 * panel collapses on an outside press or Escape. CanvasStyleSettings
 * exercises the shared composable; NodeSizeControl pins its regression.
 */

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
    fetchPending: async () => ({ revision: 0, nodes: [] }),
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

function mountControl(component: Component) {
  const workspace = createWorkspace(fakeClient());
  return mount(component, {
    global: {
      provide: { [workspaceKey as symbol]: workspace },
      plugins: [createRefinoI18n("zh")],
    },
  });
}

const pressOutside = (): void => {
  document.dispatchEvent(new MouseEvent("mousedown"));
};

const pressEscape = (): void => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
};

beforeEach(() => {
  localStorage.clear();
});

describe("float panel dismissal", () => {
  it("style settings: outside press and Escape collapse the panel", async () => {
    const wrapper = mountControl(CanvasStyleSettings);
    await wrapper.find('button[title="样式设置"]').trigger("click");
    expect(wrapper.find(".panel").exists()).toBe(true);

    // A press inside the control does not collapse it.
    wrapper
      .find(".style-settings")
      .element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(wrapper.find(".panel").exists()).toBe(true);

    pressOutside();
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".panel").exists()).toBe(false);

    await wrapper.find('button[title="样式设置"]').trigger("click");
    expect(wrapper.find(".panel").exists()).toBe(true);
    pressEscape();
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".panel").exists()).toBe(false);
  });

  it("node size: outside press and Escape collapse the expanded card", async () => {
    const wrapper = mountControl(NodeSizeControl);
    await wrapper.find('button[title="节点尺寸"]').trigger("click");
    expect(wrapper.find(".card").exists()).toBe(true);
    pressEscape();
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".card").exists()).toBe(false);

    await wrapper.find('button[title="节点尺寸"]').trigger("click");
    expect(wrapper.find(".card").exists()).toBe(true);
    pressOutside();
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".card").exists()).toBe(false);
  });
});
