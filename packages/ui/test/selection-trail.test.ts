// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createRefinoI18n } from "../src/i18n";
import { peekState } from "../src/peek";
import SelectionTrail from "../src/components/SelectionTrail.vue";
import { createWorkspace, workspaceKey } from "../src/workspace";
import type { RefinoClient } from "../src/api";

/**
 * The selection trail (ui DESIGN.md, "布局"): a multiple selection reads as
 * an ordered row of steps at the canvas's top edge — click makes the focus,
 * the cross removes, one entry clears.
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

function mountTrail() {
  const workspace = createWorkspace(fakeClient());
  const wrapper = mount(SelectionTrail, {
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

describe("SelectionTrail", () => {
  it("stays hidden for an empty or single selection", async () => {
    const { wrapper, workspace } = mountTrail();
    expect(wrapper.find(".trail").exists()).toBe(false);
    workspace.toggle({ id: "A1B2C3D4", type: "decision", summary: "决策一" });
    await vi.waitFor(() => expect(workspace.state.selection).toHaveLength(1));
    // One node needs no trail: the node pane already names it.
    expect(wrapper.find(".trail").exists()).toBe(false);
  });

  it("lists the ordered selection and makes a step the focus on click", async () => {
    const { wrapper, workspace } = mountTrail();
    workspace.toggle({ id: "A1B2C3D4", type: "decision", summary: "决策一" });
    workspace.toggle({ id: "D4E5F6G7", type: "decision", summary: "决策二" });
    await vi.waitFor(() => expect(wrapper.findAll(".step")).toHaveLength(2));
    // Indexes carry the selection order; the last step is the focus.
    expect(wrapper.findAll(".step")[1]!.classes()).toContain("focus");
    await wrapper.findAll(".step")[0]!.find(".chip").trigger("click");
    expect(workspace.state.selection).toEqual(["D4E5F6G7", "A1B2C3D4"]);
    expect(workspace.state.focusId).toBe("A1B2C3D4");
  });

  it("removes one step and clears the whole trail", async () => {
    const { wrapper, workspace } = mountTrail();
    workspace.toggle({ id: "A1B2C3D4", type: "decision", summary: "决策一" });
    workspace.toggle({ id: "D4E5F6G7", type: "decision", summary: "决策二" });
    await vi.waitFor(() => expect(wrapper.findAll(".step")).toHaveLength(2));
    await wrapper.findAll(".step")[0]!.find(".drop").trigger("click");
    expect(workspace.state.selection).toEqual(["D4E5F6G7"]);
    workspace.toggle({ id: "A1B2C3D4", type: "decision", summary: "决策一" });
    await vi.waitFor(() => expect(wrapper.findAll(".step")).toHaveLength(2));
    await wrapper.find(".clear").trigger("click");
    expect(workspace.state.selection).toEqual([]);
  });

  it("feeds the peek on hover and hides on leave", async () => {
    const { wrapper, workspace } = mountTrail();
    workspace.toggle({ id: "A1B2C3D4", type: "decision", summary: "决策一" });
    workspace.toggle({ id: "D4E5F6G7", type: "decision", summary: "决策二" });
    await vi.waitFor(() => expect(wrapper.findAll(".step")).toHaveLength(2));
    const chip = wrapper.findAll(".step")[0]!.find(".chip");
    await chip.trigger("mousemove", { clientX: 12, clientY: 34 });
    expect(peekState.id).toBe("A1B2C3D4");
    expect(peekState.x).toBe(12);
    expect(peekState.y).toBe(34);
    await chip.trigger("mouseleave");
    expect(peekState.id).toBeNull();
  });
});
