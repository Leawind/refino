// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createRefinoI18n } from "../src/i18n";
import { renderCulled } from "../src/renderStatus";
import StatusPill from "../src/components/StatusPill.vue";
import { createWorkspace, workspaceKey } from "../src/workspace";
import type { RefinoClient } from "../src/api";

/**
 * The status pill (ui DESIGN.md, "布局"): read-only canvas statistics and
 * warnings — constraint count, truncation, render culling (via the shared
 * render state), issue count and the current focus.
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

function mountPill() {
  const workspace = createWorkspace(fakeClient());
  const wrapper = mount(StatusPill, {
    global: {
      provide: { [workspaceKey as symbol]: workspace },
      plugins: [createRefinoI18n("zh")],
    },
  });
  return { wrapper, workspace };
}

beforeEach(() => {
  localStorage.clear();
  renderCulled.value = false;
});

describe("StatusPill", () => {
  it("renders the constraint count and the peek hint", () => {
    const { wrapper } = mountPill();
    expect(wrapper.text()).toContain("约束: 0");
    expect(wrapper.text()).toContain("按住 Alt 悬停可速览节点");
  });

  it("follows the shared render-culling flag", async () => {
    const { wrapper } = mountPill();
    expect(wrapper.text()).not.toContain("渲染已按预算裁剪");
    renderCulled.value = true;
    await vi.waitFor(() => expect(wrapper.text()).toContain("渲染已按预算裁剪"));
    renderCulled.value = false;
    await vi.waitFor(() => expect(wrapper.text()).not.toContain("渲染已按预算裁剪"));
  });

  it("shows the focus id from the workspace selection", async () => {
    const { wrapper, workspace } = mountPill();
    workspace.toggle({ id: "A1B2C3D4", type: "constraint", summary: "约束一" });
    await vi.waitFor(() => expect(wrapper.text()).toContain("选中: A1B2C3D4"));
  });
});
