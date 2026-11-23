// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { NMessageProvider } from "naive-ui";
import { defineComponent, h, nextTick } from "vue";
import { clientKey, type RefinoClient } from "../src/api";
import ResourceExplorer from "../src/components/ResourceExplorer.vue";
import { createRefinoI18n } from "../src/i18n";
import { createStore, storeKey } from "../src/store";
import { createWorkspace, workspaceKey } from "../src/workspace";
import type { SearchNode } from "../src/types";

const waits = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function fakeClient(
  nodes: SearchNode[] = [],
  searchFor?: (query: string) => SearchNode[],
): RefinoClient {
  return {
    queryNeighbors: async () => [],
    queryExpand: async () => [],
    queryRange: async () => ({ mode: "disconnected", nodes: [] }),
    queryGrounds: async () => [],
    search: async (params) => {
      const found = searchFor?.(params.q ?? "") ?? nodes;
      return { nodes: found };
    },
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

let wrapper: ReturnType<typeof mount> | null = null;
let workspace: ReturnType<typeof createWorkspace>;

function mountExplorer(nodes?: SearchNode[], searchFor?: (query: string) => SearchNode[]): void {
  const client = fakeClient(nodes, searchFor);
  workspace = createWorkspace(client);
  const store = createStore(client, workspace);
  // InlineNodeForm calls useMessage; it needs the provider above it.
  const host = defineComponent({
    render: () => h(NMessageProvider, null, { default: () => h(ResourceExplorer) }),
  });
  wrapper = mount(host, {
    attachTo: document.body,
    global: {
      provide: {
        [clientKey as symbol]: client,
        [workspaceKey as symbol]: workspace,
        [storeKey as symbol]: store,
      },
      plugins: [createRefinoI18n("zh")],
    },
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  workspace?.stop();
});

describe("ResourceExplorer rows", () => {
  it("selects the first hit on Enter in the search box", async () => {
    const nodes: SearchNode[] = [
      { id: "A1B2C3D4", type: "decision", summary: "决策一" },
      { id: "D4E5F6G7", type: "decision", summary: "决策二" },
    ];
    mountExplorer(nodes);
    await vi.waitFor(() => expect(wrapper!.findAll(".item")).toHaveLength(2));
    await wrapper!.find('input[placeholder*="按 id"]').trigger("keydown.enter");
    expect(workspace.state.selection).toEqual(["A1B2C3D4"]);
  });

  it("searches immediately on Enter instead of taking a stale hit", async () => {
    const old: SearchNode[] = [{ id: "A1B2C3D4", type: "decision", summary: "旧结果" }];
    const fresh: SearchNode[] = [{ id: "D4E5F6G7", type: "decision", summary: "新结果" }];
    mountExplorer(old, (query) => (query === "新" ? fresh : old));
    await vi.waitFor(() => expect(wrapper!.findAll(".item")).toHaveLength(1));
    const input = wrapper!.find('input[placeholder*="按 id"]');
    await input.setValue("新");
    // Enter before the debounce elapses: it must use the new query's result.
    await input.trigger("keydown.enter");
    await vi.waitFor(() => expect(workspace.state.selection).toEqual(["D4E5F6G7"]));
  });

  it("does not select a stale hit when the immediate search fails", async () => {
    const stale: SearchNode[] = [{ id: "A1B2C3D4", type: "decision", summary: "旧结果" }];
    mountExplorer(stale, (query) => {
      if (query === "新") throw new Error("offline");
      return stale;
    });
    await vi.waitFor(() => expect(wrapper!.findAll(".item")).toHaveLength(1));
    const input = wrapper!.find('input[placeholder*="按 id"]');
    await input.setValue("新");
    await input.trigger("keydown.enter");
    await waits(30);
    expect(workspace.state.selection).toEqual([]);
  });

  it("distinguishes the focus among selected rows", async () => {
    const nodes: SearchNode[] = [
      { id: "A1B2C3D4", type: "decision", summary: "决策一" },
      { id: "D4E5F6G7", type: "decision", summary: "决策二" },
    ];
    mountExplorer(nodes);
    await vi.waitFor(() => expect(wrapper!.findAll(".item")).toHaveLength(2));
    workspace.select(nodes[0]!);
    workspace.toggle(nodes[1]!);
    await nextTick();
    const focused = wrapper!.findAll(".item.focused");
    expect(focused).toHaveLength(1);
    expect(focused[0]!.text()).toContain("决策二");
  });

  it("shows an empty state when a search finds nothing", async () => {
    mountExplorer();
    await vi.waitFor(() => expect(wrapper!.text()).toContain("没有匹配的节点"));
  });

  it("marks each row with its node type", async () => {
    mountExplorer([
      { id: "A1B2C3D4", type: "decision", summary: "决策一" },
      { id: "D4E5F6G7", type: "premise", summary: "前提一" },
    ]);
    await vi.waitFor(() => expect(wrapper!.findAll(".item")).toHaveLength(2));
    const dots = wrapper!.findAll(".type-dot");
    expect(dots.map((dot) => dot.classes())).toEqual([
      ["type-dot", "decision"],
      ["type-dot", "premise"],
    ]);
    expect(dots[1]!.attributes("title")).toBe("前提");
  });
});

describe("ResourceExplorer filters", () => {
  it("closes the type menu on Escape without clearing the selection", async () => {
    mountExplorer();
    workspace.select({ id: "A1B2C3D4", type: "decision", summary: "决策一" });
    await nextTick();
    await wrapper!.find(".filters button").trigger("click");
    expect(document.querySelector(".n-base-select-menu")).not.toBeNull();
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await nextTick();
    expect(document.querySelector(".n-base-select-menu")).toBeNull();
    expect(workspace.state.selection).toEqual(["A1B2C3D4"]);
  });

  it("drops a narrower type filter when opening the unreferenced view", async () => {
    mountExplorer();
    const buttons = wrapper!.findAll(".filters button");
    await buttons[0]!.trigger("click");
    const option = [...document.querySelectorAll(".n-base-select-option")].find(
      (element) => element.textContent?.trim() === "决策",
    );
    expect(option).toBeDefined();
    option!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(wrapper!.find(".filters button").text()).toBe("决策"));

    await wrapper!.findAll(".filters button")[1]!.trigger("click");
    expect(wrapper!.find(".filters button").text()).toBe("前提");
  });
});
