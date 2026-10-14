// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createRefinoI18n } from "../src/i18n";
import { peekState } from "../src/peek";
import SelectionList from "../src/components/SelectionList.vue";
import { createWorkspace, workspaceKey } from "../src/workspace";
import type { RefinoClient } from "../src/api";

/**
 * The ordered selection list (ui DESIGN.md, "交互"): click locates, the
 * per-item button removes, Alt+hover feeds the peek.
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

function mountList() {
  const workspace = createWorkspace(fakeClient());
  const wrapper = mount(SelectionList, {
    global: {
      provide: { [workspaceKey as symbol]: workspace },
      plugins: [createRefinoI18n("zh")],
    },
  });
  return { wrapper, workspace };
}

beforeEach(() => {
  localStorage.clear();
  peekState.id = null;
});

describe("SelectionList", () => {
  it("stays hidden without a selection", () => {
    const { wrapper } = mountList();
    expect(wrapper.find(".selection-list").exists()).toBe(false);
  });

  it("lists the ordered selection and locates on click", async () => {
    const { wrapper, workspace } = mountList();
    workspace.toggle({ id: "A1B2C3D4", type: "decision", summary: "决策一" });
    workspace.toggle({ id: "D4E5F6G7", type: "decision", summary: "决策二" });
    await vi.waitFor(() => expect(wrapper.findAll("li").length).toBe(2));
    // Clicking an entry makes it the focus (moves it to the end).
    await wrapper.findAll("li")[0]!.trigger("click");
    expect(workspace.state.selection).toEqual(["D4E5F6G7", "A1B2C3D4"]);
    expect(workspace.state.focusId).toBe("A1B2C3D4");
  });

  it("feeds the peek on hover and hides on leave", async () => {
    const { wrapper, workspace } = mountList();
    workspace.toggle({ id: "A1B2C3D4", type: "decision", summary: "决策一" });
    await vi.waitFor(() => expect(wrapper.findAll("li").length).toBe(1));
    const li = wrapper.findAll("li")[0]!;
    await li.trigger("mousemove", { clientX: 12, clientY: 34 });
    expect(peekState.id).toBe("A1B2C3D4");
    expect(peekState.x).toBe(12);
    expect(peekState.y).toBe(34);
    await li.trigger("mouseleave");
    expect(peekState.id).toBeNull();
  });
});
