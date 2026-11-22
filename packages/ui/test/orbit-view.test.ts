// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick, reactive, ref } from "vue";
import OrbitView from "../src/components/OrbitView.vue";
import { createRefinoI18n } from "../src/i18n";
import { setViewportCommands } from "../src/viewportBridge";
import { clientKey } from "../src/api";
import { storeKey } from "../src/store";
import { workspaceKey } from "../src/workspace";

/**
 * Orbit view interaction (ui DESIGN.md, "三维视图"): clicking a star selects
 * it and glides the orbit center onto it; clicking the virtual root recenters
 * on the origin; Ctrl/Cmd-clicking a selected star only removes it from the
 * selection and leaves the center alone.
 */

interface FakePick {
  key: string;
  id: string | null;
}

const orbit = vi.hoisted(() => ({
  focusOn: vi.fn(),
  focusOnNode: vi.fn((id: string) => {
    if (orbit.focus?.id === id) return true;
    orbit.setFocus({ key: id === "P" ? "P@A" : id, id });
    return true;
  }),
  rootHover: vi.fn(),
  beginDrag: vi.fn(() => true),
  dragTo: vi.fn(),
  endDrag: vi.fn(),
  pick: vi.fn((): FakePick | null => ({ key: "A", id: "A" })),
  /** Mirrors the real scene's focus for the callout overlay. */
  focus: null as { key: string; id: string | null } | null,
  focusHandler: null as (() => void) | null,
  frameHandler: null as (() => void) | null,
  setFocus: vi.fn((focus: { key: string; id: string | null } | null) => {
    orbit.focus = focus;
    orbit.focusHandler?.();
  }),
}));

vi.mock("../src/graph/orbit/scene", () => {
  class FakeScene {
    scale = 1;
    viewport = { width: 800, height: 600 };
    static create(): FakeScene {
      return new FakeScene();
    }
    resize(): void {}
    setData(): void {}
    setState(): void {}
    pick(): FakePick | null {
      return orbit.pick();
    }
    project() {
      return { x: 0, y: 0, visible: true };
    }
    zoomBy(): void {}
    fitView(): void {}
    fitSelection(): void {}
    focusOn(key: string): void {
      orbit.focusOn(key);
      orbit.setFocus({ key, id: key.includes("@") ? key.split("@")[0]! : key });
    }
    focusOnNode(id: string): boolean {
      return orbit.focusOnNode(id);
    }
    get focus() {
      return orbit.focus;
    }
    onFocusChanged(handler: (() => void) | null): void {
      orbit.focusHandler = handler;
    }
    screenLayout() {
      return {
        width: 800,
        height: 600,
        stars: [{ x: 400, y: 300, radius: 12 }],
        anchor: { x: 400, y: 300, radius: 12 },
        nodes: [
          {
            key: "A",
            id: "A",
            type: "decision",
            x: 400,
            y: 300,
            radius: 12,
            distance: 20,
            interacted: false,
            ground: false,
          },
          {
            key: "P@A",
            id: "P",
            type: "premise",
            x: 470,
            y: 300,
            radius: 8,
            distance: 20,
            interacted: false,
            ground: true,
          },
        ],
        referenceDistance: 20,
      };
    }
    focusScreen() {
      return { x: 400, y: 300, radius: 12 };
    }
    beginDrag(id: string): boolean {
      return orbit.beginDrag(id);
    }
    dragTo(): void {
      orbit.dragTo();
    }
    endDrag(): void {
      orbit.endDrag();
    }
    setRootHover(hovered: boolean): void {
      orbit.rootHover(hovered);
    }
    onCameraChanged(): void {}
    onFrame(handler: (() => void) | null): void {
      orbit.frameHandler = handler;
    }
    requestRender(): void {}
    dispose(): void {}
  }
  return { OrbitScene: FakeScene, ORBIT_ROOT_ID: "__root__" };
});

interface FakeNode {
  id: string;
  type: "decision" | "premise";
  summary: string;
  grounds: string[];
}

function fakeWorkspace(nodes?: FakeNode[]) {
  const displayed = ref<FakeNode[]>(
    nodes ?? [
      { id: "A", type: "decision", summary: "Alpha", grounds: [] },
      { id: "P", type: "premise", summary: "Fact", grounds: [] },
    ],
  );
  const state = reactive({
    selection: [] as string[],
    focusId: null as string | null,
    hoveredId: null as string | null,
  });
  function setSelection(ids: string[]): void {
    state.selection = ids;
    state.focusId = ids[ids.length - 1] ?? null;
  }
  return {
    displayed,
    state,
    select: vi.fn((target: FakeNode) => setSelection([target.id])),
    toggle: vi.fn((target: FakeNode) => {
      setSelection(
        state.selection.includes(target.id)
          ? state.selection.filter((id) => id !== target.id)
          : [...state.selection, target.id],
      );
    }),
    clearSelection: vi.fn(() => setSelection([])),
    rangeSelect: vi.fn(async () => {}),
    hover: vi.fn((id: string) => {
      state.hoveredId = id;
    }),
    unhover: vi.fn(() => {
      state.hoveredId = null;
    }),
  };
}

let wrapper: ReturnType<typeof mount> | null = null;

function mountOrbit(workspace: ReturnType<typeof fakeWorkspace>) {
  const store = { openDetail: vi.fn(), startCreate: vi.fn() };
  const client = {
    fetchNode: vi.fn(async (id: string) => ({
      revision: 1,
      node: { id, type: "decision", summary: "Alpha", body: "Body from the record." },
      issues: [],
    })),
  };
  wrapper = mount(OrbitView, {
    attachTo: document.body,
    global: {
      provide: {
        [workspaceKey as symbol]: workspace as never,
        [storeKey as symbol]: store as never,
        [clientKey as symbol]: client as never,
      },
      plugins: [createRefinoI18n("zh")],
    },
  });
  return wrapper;
}

function clickOnStar(init: MouseEventInit = {}): void {
  const canvas = wrapper!.find("canvas").element;
  const event = { button: 0, clientX: 24, clientY: 32, bubbles: true, ...init };
  canvas.dispatchEvent(new MouseEvent("pointerdown", event));
  canvas.dispatchEvent(new MouseEvent("pointerup", event));
}

beforeEach(() => {
  orbit.focusOn.mockClear();
  orbit.focusOnNode.mockClear();
  orbit.rootHover.mockClear();
  orbit.beginDrag.mockClear();
  orbit.dragTo.mockClear();
  orbit.endDrag.mockClear();
  orbit.beginDrag.mockReturnValue(true);
  orbit.pick.mockReturnValue({ key: "A", id: "A" });
  orbit.focus = null;
  orbit.focusHandler = null;
  orbit.frameHandler = null;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  setViewportCommands(null);
  vi.unstubAllGlobals();
});

describe("orbit view focus", () => {
  it("centers the orbit on the clicked star", () => {
    const workspace = fakeWorkspace();
    mountOrbit(workspace);
    clickOnStar();
    expect(workspace.select).toHaveBeenCalledWith(expect.objectContaining({ id: "A" }));
    expect(orbit.focusOn).toHaveBeenCalledWith("A");
  });

  it("focuses a premise satellite by its copy key", () => {
    const workspace = fakeWorkspace();
    orbit.pick.mockReturnValue({ key: "P@A", id: "P" });
    mountOrbit(workspace);
    clickOnStar();
    expect(workspace.select).toHaveBeenCalledWith(expect.objectContaining({ id: "P" }));
    expect(orbit.focusOn).toHaveBeenCalledWith("P@A");
  });

  it("clears the selection and centers on the virtual root when it is clicked", () => {
    const workspace = fakeWorkspace();
    orbit.pick.mockReturnValue({ key: "__root__", id: null });
    mountOrbit(workspace);
    clickOnStar();
    expect(workspace.clearSelection).toHaveBeenCalled();
    expect(workspace.select).not.toHaveBeenCalled();
    expect(orbit.focusOn).toHaveBeenCalledWith("__root__");
  });

  it("shows a pointer cursor and a root hover glow over the virtual root", () => {
    const workspace = fakeWorkspace();
    orbit.pick.mockReturnValue({ key: "__root__", id: null });
    mountOrbit(workspace);
    const canvas = wrapper!.find("canvas").element as HTMLCanvasElement;
    canvas.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 24, clientY: 32, bubbles: true }),
    );
    expect(orbit.rootHover).toHaveBeenLastCalledWith(true);
    expect(canvas.style.cursor).toBe("pointer");
    orbit.pick.mockReturnValue(null);
    canvas.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 30, clientY: 40, bubbles: true }),
    );
    expect(orbit.rootHover).toHaveBeenLastCalledWith(false);
    expect(canvas.style.cursor).toBe("default");
  });

  it("does not re-center when a Ctrl-click removes the star from the selection", () => {
    const workspace = fakeWorkspace();
    workspace.state.selection = ["A"];
    mountOrbit(workspace);
    clickOnStar({ ctrlKey: true });
    expect(workspace.toggle).toHaveBeenCalled();
    expect(orbit.focusOn).not.toHaveBeenCalled();
  });

  it("re-centers when a Ctrl-click adds the star to the selection", () => {
    const workspace = fakeWorkspace();
    mountOrbit(workspace);
    clickOnStar({ ctrlKey: true });
    expect(orbit.focusOn).toHaveBeenCalledWith("A");
  });

  it("drags a decision inside the view plane instead of selecting it", () => {
    const workspace = fakeWorkspace();
    mountOrbit(workspace);
    const canvas = wrapper!.find("canvas").element;
    canvas.dispatchEvent(
      new MouseEvent("pointerdown", { button: 0, clientX: 24, clientY: 32, bubbles: true }),
    );
    canvas.dispatchEvent(
      new MouseEvent("pointermove", {
        button: 0,
        buttons: 1,
        clientX: 64,
        clientY: 52,
        bubbles: true,
      }),
    );
    expect(orbit.beginDrag).toHaveBeenCalledWith("A");
    expect(orbit.dragTo).toHaveBeenCalled();
    canvas.dispatchEvent(
      new MouseEvent("pointerup", { button: 0, clientX: 64, clientY: 52, bubbles: true }),
    );
    expect(orbit.endDrag).toHaveBeenCalledTimes(1);
    expect(workspace.select).not.toHaveBeenCalled();
    expect(orbit.focusOn).not.toHaveBeenCalled();
  });

  it("does not drag premise satellites", () => {
    const workspace = fakeWorkspace();
    orbit.pick.mockReturnValue({ key: "P@A", id: "P" });
    mountOrbit(workspace);
    const canvas = wrapper!.find("canvas").element;
    canvas.dispatchEvent(
      new MouseEvent("pointerdown", { button: 0, clientX: 24, clientY: 32, bubbles: true }),
    );
    canvas.dispatchEvent(
      new MouseEvent("pointermove", {
        button: 0,
        buttons: 1,
        clientX: 64,
        clientY: 52,
        bubbles: true,
      }),
    );
    expect(orbit.beginDrag).not.toHaveBeenCalled();
  });

  it("leaves the center alone when the click misses every star", () => {
    const workspace = fakeWorkspace();
    orbit.pick.mockReturnValue(null);
    mountOrbit(workspace);
    clickOnStar();
    expect(workspace.clearSelection).toHaveBeenCalled();
    expect(orbit.focusOn).not.toHaveBeenCalled();
  });

  it("follows a focus set outside the canvas", async () => {
    const workspace = fakeWorkspace();
    mountOrbit(workspace);
    workspace.state.focusId = "P";
    await nextTick();
    expect(orbit.focusOnNode).toHaveBeenCalledWith("P");
    expect(orbit.focus).toEqual({ key: "P@A", id: "P" });
  });

  it("retries an external focus whose star arrives with the working set", async () => {
    const workspace = fakeWorkspace();
    orbit.focusOnNode.mockReturnValueOnce(false);
    mountOrbit(workspace);
    workspace.state.focusId = "A";
    await nextTick();
    expect(orbit.focusOnNode).toHaveBeenCalledTimes(1);
    // A selection change re-expands the working set and refreshes the scene.
    workspace.displayed.value = [
      ...workspace.displayed.value,
      { id: "B", type: "decision", summary: "Beta", grounds: [] },
    ];
    await flushPromises();
    expect(orbit.focusOnNode).toHaveBeenCalledTimes(2);
    expect(orbit.focus).toEqual({ key: "A", id: "A" });
  });
});

describe("orbit callout", () => {
  it("floats the focused star's content in the picture", async () => {
    const workspace = fakeWorkspace();
    mountOrbit(workspace);
    clickOnStar();
    await flushPromises();
    // The record is fetched by a watcher that runs after the focus renders.
    await nextTick();
    await flushPromises();
    const block = wrapper!.find(".callout");
    expect(block.exists()).toBe(true);
    expect(block.find(".summary").text()).toBe("Alpha");
    expect(block.find(".body").text()).toContain("Body from the record.");
  });

  it("clears the callout when the center leaves the star", async () => {
    const workspace = fakeWorkspace();
    mountOrbit(workspace);
    clickOnStar();
    await flushPromises();
    expect(wrapper!.find(".callout").exists()).toBe(true);
    orbit.setFocus(null);
    await nextTick();
    await nextTick();
    expect(wrapper!.find(".callout").exists()).toBe(false);
  });

  it("shows nothing for the virtual root", async () => {
    const workspace = fakeWorkspace();
    orbit.pick.mockReturnValue({ key: "__root__", id: null });
    mountOrbit(workspace);
    clickOnStar();
    expect(orbit.focusOn).toHaveBeenCalledWith("__root__");
    orbit.setFocus({ key: "__root__", id: null });
    await nextTick();
    expect(wrapper!.find(".callout").exists()).toBe(false);
  });

  it("drops the leader when focus moves from a star to the virtual root", async () => {
    const workspace = fakeWorkspace();
    mountOrbit(workspace);
    clickOnStar();
    await flushPromises();
    orbit.frameHandler?.();
    const leader = wrapper!.find(".callout-leader line").element as SVGLineElement;
    expect(leader.style.display).not.toBe("none");
    orbit.setFocus({ key: "__root__", id: null });
    await nextTick();
    orbit.frameHandler?.();
    expect((wrapper!.find(".callout-leader line").element as SVGLineElement).style.display).toBe(
      "none",
    );
  });

  it("labels prominent stars whether or not a star is focused", async () => {
    const workspace = fakeWorkspace();
    mountOrbit(workspace);
    clickOnStar();
    await flushPromises();
    orbit.frameHandler?.();
    await nextTick();
    const labels = wrapper!.findAll(".satellite-label");
    expect(labels).toHaveLength(1);
    expect(labels[0]!.find(".summary").text()).toBe("Fact");
    expect(labels[0]!.find(".satellite-rule").exists()).toBe(true);
    expect(wrapper!.findAll("[data-sat-line]")).toHaveLength(1);
    // The ground's label reads smaller than a full-size summary.
    expect(
      Number(
        labels[0]!
          .find(".summary")
          .attributes("style")
          ?.match(/font-size: ([\d.]+)px/)?.[1],
      ),
    ).toBeLessThan(13);
    orbit.setFocus({ key: "__root__", id: null });
    await nextTick();
    orbit.frameHandler?.();
    await nextTick();
    // With no focus, the formerly focused decision competes on prominence too.
    const after = wrapper!.findAll(".satellite-label");
    expect(after).toHaveLength(2);
    expect(after.map((label) => label.find(".summary").text())).toEqual(["Alpha", "Fact"]);
  });
});
