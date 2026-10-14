// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createRefinoI18n } from "../src/i18n";
import { renderCulled } from "../src/renderStatus";
import StatusPill from "../src/components/StatusPill.vue";
import { createWorkspace, workspaceKey } from "../src/workspace";
import type { IssueRecord } from "../src/types";
import type { RefinoClient } from "../src/api";

/**
 * The status pill (ui DESIGN.md, "布局"): read-only canvas statistics and
 * warnings — decision count, truncation, render culling (via the shared
 * render state), issue count and the current focus.
 */

function fakeClient(issues: IssueRecord[] = []): RefinoClient {
  return {
    queryNeighbors: async () => [],
    queryExpand: async () => [],
    queryRange: async () => ({ mode: "disconnected", nodes: [] }),
    queryGrounds: async () => [],
    search: async () => ({ nodes: [] }),
    fetchNode: async () => {
      throw new Error("not used");
    },
    fetchIssues: async () => ({ ok: true, issues, revision: 0 }),
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

function mountPill(issues: IssueRecord[] = []) {
  const workspace = createWorkspace(fakeClient(issues));
  const wrapper = mount(StatusPill, {
    global: {
      provide: { [workspaceKey as symbol]: workspace },
      plugins: [createRefinoI18n("zh")],
    },
  });
  return { wrapper, workspace };
}

/** Brings the given issues into the workspace state; the pill only reads
 * state.issues, which refreshIssues fills (via start()). */
async function mountWithIssues(issues: IssueRecord[]) {
  const mounted = mountPill(issues);
  mounted.workspace.start();
  await vi.waitFor(() => expect(mounted.wrapper.text()).toContain("校验问题: 1"));
  return mounted;
}

beforeEach(() => {
  localStorage.clear();
  renderCulled.value = false;
});

describe("StatusPill", () => {
  it("renders the decision count and the peek hint", () => {
    const { wrapper } = mountPill();
    expect(wrapper.text()).toContain("决策: 0");
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
    workspace.toggle({ id: "A1B2C3D4", type: "decision", summary: "决策一" });
    await vi.waitFor(() => expect(wrapper.text()).toContain("选中: A1B2C3D4"));
  });

  it("expands the issue list and locates a node from it", async () => {
    const { wrapper, workspace } = await mountWithIssues([
      { code: "cycle", message: "依据构成环路", nodeId: "A1B2C3D4" },
    ]);
    // The trigger is the issue count button.
    const trigger = wrapper.find(".issue-trigger");
    expect(trigger.text()).toBe("校验问题: 1");
    await trigger.trigger("click");
    await vi.waitFor(() => expect(document.body.textContent).toContain("依据构成环路"));
    const locate = [...document.body.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("定位"),
    );
    expect(locate).toBeDefined();
    locate!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(workspace.state.selection).toEqual(["A1B2C3D4"]));
    workspace.stop();
  });

  it("offers no locate for issues without a node", async () => {
    const { wrapper, workspace } = await mountWithIssues([
      { code: "empty", message: "图不含任何决策" },
    ]);
    await wrapper.find(".issue-trigger").trigger("click");
    await vi.waitFor(() => expect(document.body.textContent).toContain("图不含任何决策"));
    // Earlier tests' teleported panels may linger in the body; only the
    // latest one belongs to this mount.
    const panels = document.body.querySelectorAll(".issue-panel");
    const panel = panels[panels.length - 1]!;
    expect(panel.textContent).toContain("图不含任何决策");
    expect(panel.querySelector("button")).toBeNull();
    workspace.stop();
  });
});
