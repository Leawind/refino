// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { computed, reactive } from "vue";
import type { RefinoClient } from "../src/api";
import ReviewDrawer from "../src/components/ReviewDrawer.vue";
import { createRefinoI18n } from "../src/i18n";
import { reviewKey } from "../src/review";
import { createWorkspace, workspaceKey } from "../src/workspace";

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

describe("ReviewDrawer", () => {
  it("closes the drawer when locating an entry", async () => {
    const workspace = createWorkspace(fakeClient());
    const state = reactive({
      open: true,
      entries: [{ id: "A1B2C3D4", revision: 1, origin: "api" as const, deleted: false }],
      lastSeenRevision: 0,
    });
    const closeDrawer = vi.fn(() => {
      state.open = false;
    });
    const review = {
      state,
      unseen: computed(() => state.entries),
      openDrawer: vi.fn(),
      closeDrawer,
    };
    const wrapper = mount(ReviewDrawer, {
      attachTo: document.body,
      global: {
        provide: {
          [reviewKey as symbol]: review,
          [workspaceKey as symbol]: workspace,
        },
        plugins: [createRefinoI18n("zh")],
      },
    });

    const locate = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("定位"),
    );
    expect(locate).toBeDefined();
    locate!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(workspace.state.selection).toEqual(["A1B2C3D4"]);
    expect(closeDrawer).toHaveBeenCalledTimes(1);
    wrapper.unmount();
    workspace.stop();
  });
});
