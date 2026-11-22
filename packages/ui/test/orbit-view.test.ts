// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { reactive, ref } from "vue";
import OrbitView from "../src/components/OrbitView.vue";
import { createRefinoI18n } from "../src/i18n";
import { setViewportCommands } from "../src/viewportBridge";
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
  rootHover: vi.fn(),
  pick: vi.fn((): FakePick | null => ({ key: "A", id: "A" })),
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
    }
    setRootHover(hovered: boolean): void {
      orbit.rootHover(hovered);
    }
    onCameraChanged(): void {}
    onFrame(): void {}
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
    hoveredId: null as string | null,
  });
  return {
    displayed,
    state,
    select: vi.fn((target: FakeNode) => {
      state.selection = [target.id];
    }),
    toggle: vi.fn((target: FakeNode) => {
      state.selection = state.selection.includes(target.id) ? [] : [target.id];
    }),
    clearSelection: vi.fn(() => {
      state.selection = [];
    }),
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
  wrapper = mount(OrbitView, {
    attachTo: document.body,
    global: {
      provide: {
        [workspaceKey as symbol]: workspace as never,
        [storeKey as symbol]: store as never,
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
  orbit.rootHover.mockClear();
  orbit.pick.mockReturnValue({ key: "A", id: "A" });
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

  it("leaves the center alone when the click misses every star", () => {
    const workspace = fakeWorkspace();
    orbit.pick.mockReturnValue(null);
    mountOrbit(workspace);
    clickOnStar();
    expect(workspace.clearSelection).toHaveBeenCalled();
    expect(orbit.focusOn).not.toHaveBeenCalled();
  });
});
