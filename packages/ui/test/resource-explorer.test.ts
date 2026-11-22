// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { NMessageProvider } from "naive-ui";
import { defineComponent, h } from "vue";
import { clientKey, type RefinoClient } from "../src/api";
import ResourceExplorer from "../src/components/ResourceExplorer.vue";
import { createRefinoI18n } from "../src/i18n";
import { createStore, storeKey } from "../src/store";
import { createWorkspace, workspaceKey } from "../src/workspace";
import type { SearchNode } from "../src/types";

function fakeClient(nodes: SearchNode[] = []): RefinoClient {
  return {
    queryNeighbors: async () => [],
    queryExpand: async () => [],
    queryRange: async () => ({ mode: "disconnected", nodes: [] }),
    queryGrounds: async () => [],
    search: async () => ({ nodes }),
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

function mountExplorer(nodes?: SearchNode[]): void {
  const client = fakeClient(nodes);
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
