// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefinoClient } from "../src/api";
import { closeHelp, helpState } from "../src/help";
import { closePalette, paletteState } from "../src/palette";
import { installShortcuts } from "../src/shortcuts";
import { createStore, type Store } from "../src/store";
import { setViewportCommands } from "../src/viewportBridge";
import { createWorkspace, type Workspace } from "../src/workspace";

/**
 * Global shortcut dispatch (ui DESIGN.md, "交互"): registry-bound keys run
 * their command; the dispatcher stands down for text entry, the open
 * palette and the open detail editor, which own the keyboard themselves.
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
let store: Store;
let removeShortcuts: (() => void) | null = null;

function key(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  document.activeElement?.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  localStorage.clear();
  closePalette();
  closeHelp();
  const client = fakeClient();
  workspace = createWorkspace(client);
  store = createStore(client, workspace);
  document.body.replaceChildren();
  removeShortcuts = installShortcuts({ store, workspace });
});

afterEach(() => {
  removeShortcuts?.();
  removeShortcuts = null;
  workspace.stop();
  setViewportCommands(null);
  closePalette();
  closeHelp();
});

describe("shortcut dispatch", () => {
  it("runs viewport commands through the bridge", () => {
    const zoomBy = vi.fn();
    const fitView = vi.fn();
    const fitSelection = vi.fn();
    setViewportCommands({ zoomBy, fitView, fitSelection });

    const zoomIn = key("=", { ctrlKey: true });
    expect(zoomIn.defaultPrevented).toBe(true);
    expect(zoomBy).toHaveBeenCalledWith(1.25);

    key("-", { ctrlKey: true });
    expect(zoomBy).toHaveBeenCalledWith(1 / 1.25);

    key("!", { code: "Digit1", shiftKey: true });
    expect(fitView).toHaveBeenCalledTimes(1);

    key("!", { code: "Digit2", shiftKey: true });
    expect(fitSelection).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no canvas has registered viewport commands", () => {
    const event = key("=", { ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
  });

  it("toggles the shortcut help overlay with ?", () => {
    key("?");
    expect(helpState.open).toBe(true);
    key("?");
    expect(helpState.open).toBe(false);
  });

  it("stands down while the palette is open", () => {
    paletteState.open = true;
    key("?");
    expect(helpState.open).toBe(false);
    closePalette();
  });

  it("stands down while the detail editor is open", () => {
    store.startCreate("decision");
    key("?");
    expect(helpState.open).toBe(false);
    store.cancelCreate();
  });

  it("stands down for text entry surfaces", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const zoomBy = vi.fn();
    setViewportCommands({ zoomBy, fitView: vi.fn(), fitSelection: vi.fn() });
    const event = new KeyboardEvent("keydown", {
      key: "=",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    expect(zoomBy).not.toHaveBeenCalled();
    input.remove();
  });
});
