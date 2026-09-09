// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createRefinoI18n } from "../src/i18n";
import LayoutControls from "../src/components/LayoutControls.vue";
import { createWorkspace, workspaceKey } from "../src/workspace";
import type { RefinoClient } from "../src/api";

/**
 * The layout controls (ui DESIGN.md, "布局"): layout mode, display
 * direction and the premises layer toggle — all persisted canvas config
 * values written through workspace.setConfig.
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

function mountControls() {
  const workspace = createWorkspace(fakeClient());
  const wrapper = mount(LayoutControls, {
    global: {
      provide: { [workspaceKey as symbol]: workspace },
      plugins: [createRefinoI18n("zh")],
    },
  });
  return { wrapper, workspace };
}

beforeEach(() => {
  localStorage.clear();
});

describe("LayoutControls", () => {
  it("reflects the persisted layout config", () => {
    const { wrapper } = mountControls();
    expect(wrapper.find('button[title="布局"]').text()).toBe("≡");
    expect(wrapper.find('button[title="方向"]').text().trim()).toBe("LR");
  });

  it("toggles the premises layer through the canvas config", async () => {
    const { wrapper, workspace } = mountControls();
    const initial = workspace.state.config.showPremises;
    await wrapper.find('button[title="前提事实层"]').trigger("click");
    expect(workspace.state.config.showPremises).toBe(!initial);
    await wrapper.find('button[title="前提事实层"]').trigger("click");
    expect(workspace.state.config.showPremises).toBe(initial);
  });
});
