// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick } from "vue";
import { NMessageProvider } from "naive-ui";
import { clientKey, type RefinoClient } from "../src/api";
import ResourceExplorer from "../src/components/ResourceExplorer.vue";
import { createRefinoI18n } from "../src/i18n";
import { createReview, reviewKey } from "../src/review";
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
let store: ReturnType<typeof createStore>;

function mountExplorer(nodes?: SearchNode[], searchFor?: (query: string) => SearchNode[]): void {
  const client = fakeClient(nodes, searchFor);
  workspace = createWorkspace(client);
  store = createStore(client, workspace);
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
        [reviewKey as symbol]: createReview(workspace),
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
    const glyphs = wrapper!.findAll(".glyph");
    expect(glyphs.map((glyph) => glyph.classes())).toEqual([
      ["glyph", "decision"],
      ["glyph", "premise"],
    ]);
    expect(glyphs[1]!.attributes("title")).toBe("前提");
  });

  it("opens the editor sheet on double click", async () => {
    mountExplorer([{ id: "A1B2C3D4", type: "decision", summary: "决策一" }]);
    await vi.waitFor(() => expect(wrapper!.findAll(".item")).toHaveLength(1));
    await wrapper!.findAll(".item")[0]!.trigger("dblclick");
    // The sheet is a store session, not a route: the app shell mounts it.
    expect(store.state.editorOpen).toBe(true);
  });
});

describe("ResourceExplorer scopes", () => {
  it("keeps the scope chips mutually exclusive", async () => {
    mountExplorer();
    const chips = wrapper!.findAll(".scopes .ui-chip");
    expect(chips.map((chip) => chip.text())).toEqual(["全部", "决策", "前提", "未被引用的前提"]);
    await chips[1]!.trigger("click");
    await nextTick();
    expect(chips[1]!.classes()).toContain("is-on");
    expect(chips[0]!.classes()).not.toContain("is-on");

    // The unreferenced view supersedes the type chips (it is premises only).
    await chips[3]!.trigger("click");
    await nextTick();
    expect(chips[3]!.classes()).toContain("is-on");
    expect(chips[1]!.classes()).not.toContain("is-on");
    expect(chips[2]!.classes()).not.toContain("is-on");
  });

  it("creates from the pinned footer", async () => {
    mountExplorer();
    const create = wrapper!.findAll(".create-btn");
    expect(create.map((button) => button.text())).toEqual(["决策", "前提"]);
    await create[1]!.trigger("click");
    expect(store.state.creatingType).toBe("premise");
    expect(store.state.editorOpen).toBe(true);
  });
});
