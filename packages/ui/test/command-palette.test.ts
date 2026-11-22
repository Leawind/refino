// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { clientKey } from "../src/api";
import type { RefinoClient } from "../src/api";
import { createRefinoI18n } from "../src/i18n";
import { createNodeOps, nodeOpsKey } from "../src/nodeOps";
import { closePalette, paletteState } from "../src/palette";
import CommandPalette from "../src/components/CommandPalette.vue";
import { storeKey, createStore } from "../src/store";
import { createWorkspace, workspaceKey } from "../src/workspace";
import type { SearchNode } from "../src/types";

/**
 * The command palette (ui DESIGN.md, "命令面板"): keyboard navigation and
 * closing must work while the search input holds focus — the handlers sit
 * on document, so nothing between the input and document may stop keydown
 * propagation (a past `@keydown.stop` on the input dead-marked every key
 * while focused, which is always after open). Opening is the registry's
 * job, covered by the shortcut-dispatch tests.
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

/** One wrapper per test; unmounted in afterEach. The palette hangs its
 * keydown handler on document, so an unmounted-late instance would keep
 * handling keys across tests and double-toggle or double-execute. */
const wrappers: Array<ReturnType<typeof mount>> = [];

function mountPalette(nodes: SearchNode[] = []) {
  const client = fakeClient();
  client.search = async () => ({ nodes });
  const workspace = createWorkspace(client);
  const store = createStore(client, workspace);
  const nodeOps = createNodeOps(client, store, workspace, (key) => key);
  const wrapper = mount(CommandPalette, {
    global: {
      provide: {
        [workspaceKey as symbol]: workspace,
        [storeKey as symbol]: store,
        [clientKey as symbol]: client,
        [nodeOpsKey as symbol]: nodeOps,
      },
      plugins: [createRefinoI18n("zh")],
    },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  return { wrapper, workspace, store };
}

/** Keydowns dispatch on the focused element and must reach the palette's
 * document-level handler through bubbling. */
function key(key: string, init: KeyboardEventInit = {}): void {
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
  );
}

const waits = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  localStorage.clear();
  closePalette();
});

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount();
  closePalette();
});

describe("CommandPalette keyboard", () => {
  it("opens from the singleton with a fresh search state", async () => {
    mountPalette();
    expect(document.querySelector(".palette")).toBeNull();
    paletteState.open = true;
    await waits(50);
    expect(document.querySelector(".palette")).not.toBeNull();
    // The input grabs focus so typing goes straight into the query.
    expect(document.activeElement?.classList.contains("input")).toBe(true);
  });

  it("navigates, executes and closes by keyboard while the input is focused", async () => {
    const { store } = mountPalette();
    paletteState.open = true;
    await waits(50);
    const labels = () =>
      [...document.querySelectorAll(".palette li")].map((li) => li.textContent ?? "");
    expect(labels()[0]).toContain("新建决策");

    key("ArrowDown");
    await waits(20);
    expect(document.querySelector(".palette li.active .label")?.textContent).toContain("新建前提");

    key("ArrowUp");
    await waits(20);
    expect(document.querySelector(".palette li.active .label")?.textContent).toContain("新建决策");

    // Enter executes the active action: 新建决策 opens the create editor.
    key("Enter");
    await waits(20);
    expect(paletteState.open).toBe(false);
    expect(store.state.creatingType).toBe("decision");
    store.cancelCreate();
  });

  it("resets the highlight when a query narrows the results", async () => {
    const { store } = mountPalette();
    paletteState.open = true;
    await waits(50);
    for (let i = 0; i < 12; i++) key("ArrowDown");
    await waits(20);
    // The palette is teleported to body, outside the component wrapper.
    const input = document.querySelector(".palette .input") as HTMLInputElement;
    input.value = "新建前提";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await waits(20);
    expect(document.querySelectorAll(".palette li")).toHaveLength(1);
    expect(document.querySelector(".palette li.active .label")?.textContent).toContain("新建前提");
    key("Enter");
    await waits(20);
    expect(store.state.creatingType).toBe("premise");
    store.cancelCreate();
  });

  it("tags node hits with their type and leaves action rows untagged", async () => {
    mountPalette([
      { id: "A1B2C3D4", type: "decision", summary: "决策一" },
      { id: "D4E5F6G7", type: "premise", summary: "前提一" },
    ]);
    paletteState.open = true;
    await waits(320);
    const rows = [...document.querySelectorAll(".palette li")];
    const tagged = rows.filter((row) => row.querySelector(".kind") !== null);
    expect(tagged.map((row) => row.querySelector(".kind")?.textContent)).toEqual(["决策", "前提"]);
    const create = rows.find((row) => row.textContent?.includes("新建决策"));
    expect(create?.querySelector(".kind")).toBeNull();
  });

  it("closes on Escape without clearing the selection", async () => {
    const { workspace } = mountPalette();
    workspace.select({ id: "A1B2C3D4", type: "decision", summary: "决策一" });
    paletteState.open = true;
    await waits(50);
    key("Escape");
    await waits(20);
    expect(paletteState.open).toBe(false);
    expect(workspace.state.selection).toEqual(["A1B2C3D4"]);
  });

  it("closes on Ctrl/Cmd+K while the input holds focus", async () => {
    mountPalette();
    paletteState.open = true;
    await waits(50);
    key("k", { ctrlKey: true });
    await waits(20);
    expect(paletteState.open).toBe(false);
  });
});
