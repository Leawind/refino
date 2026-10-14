// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { clientKey } from "../src/api";
import type { RefinoClient } from "../src/api";
import CanvasContextMenu from "../src/components/CanvasContextMenu.vue";
import { createRefinoI18n } from "../src/i18n";
import { createNodeOps, nodeOpsKey, type NodeOps } from "../src/nodeOps";
import { createStore, storeKey } from "../src/store";
import { createWorkspace, workspaceKey } from "../src/workspace";
import type { Workspace } from "../src/workspace";

/**
 * The canvas context menu (ui DESIGN.md, "交互"): node entries act on the
 * node, empty-space entries create and fit; Esc closes on the capture phase
 * so the app shell's clear-selection listener never fires.
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

let workspace: Workspace;
let store: ReturnType<typeof createStore>;
let nodeOps: NodeOps;
const wrappers: Array<ReturnType<typeof mount>> = [];

function mountMenu(nodeId: string | null) {
  const wrapper = mount(CanvasContextMenu, {
    props: { x: 40, y: 60, nodeId },
    global: {
      provide: {
        [workspaceKey as symbol]: workspace,
        [storeKey as symbol]: store,
        [nodeOpsKey as symbol]: nodeOps,
        [clientKey as symbol]: fakeClient(),
      },
      plugins: [createRefinoI18n("zh")],
    },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  return wrapper;
}

const keyOn = (target: EventTarget, key: string): void =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

/** The menu teleports to body, outside VTU's tree. */
const items = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>(".menu .item"),
];

beforeEach(() => {
  localStorage.clear();
  const client = fakeClient();
  workspace = createWorkspace(client);
  store = createStore(client, workspace);
  nodeOps = createNodeOps(client, store, workspace, (key) => key);
});

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount();
});

describe("CanvasContextMenu", () => {
  it("offers node actions and opens the editor from them", () => {
    const wrapper = mountMenu("A1B2C3D4");
    expect(items().map((item) => item.textContent)).toEqual([
      "编辑",
      "定位（设为焦点）",
      "切换选中",
      "以此细化",
      "删除",
    ]);
    items()[0]!.click();
    expect(store.state.detailOpen).toBe(true);
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("stages a refine create with the node pre-filled as ground", () => {
    mountMenu("A1B2C3D4");
    items()[3]!.click();
    expect(store.state.creatingType).toBe("decision");
    expect(store.form.grounds).toEqual(["A1B2C3D4"]);
  });

  it("locates a node from the menu", () => {
    const wrapper = mountMenu("A1B2C3D4");
    items()[1]!.click();
    expect(workspace.state.selection).toEqual(["A1B2C3D4"]);
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("offers creation and fit on empty space", () => {
    mountMenu(null);
    expect(items().map((item) => item.textContent)).toEqual(["新建决策", "新建前提", "适应视图"]);
    items()[1]!.click();
    expect(store.state.creatingType).toBe("premise");
  });

  it("closes on Escape ahead of the app shell (capture phase)", () => {
    const wrapper = mountMenu("A1B2C3D4");
    keyOn(window, "Escape");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("closes on an outside press", () => {
    const wrapper = mountMenu(null);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("navigates with the keyboard and runs on Enter", () => {
    const wrapper = mountMenu(null);
    keyOn(window, "ArrowDown");
    keyOn(window, "Enter");
    expect(store.state.creatingType).toBe("premise");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
});
