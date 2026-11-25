// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { NSlider } from "naive-ui";
import { createRefinoI18n } from "../src/i18n";
import { setViewportCommands } from "../src/viewportBridge";
import { createWorkspace, workspaceKey } from "../src/workspace";
import OrbitControl from "../src/components/OrbitControl.vue";
import type { RefinoClient } from "../src/api";
import type { ViewportFov } from "../src/viewportBridge";

/**
 * The orbit view settings panel (ui DESIGN.md, "三维视图"): one bottom-right
 * button expands the grouped sliders. The field of view rides the viewport
 * bridge; every other row is a persisted canvas config entry, so it applies
 * to the next view switch too.
 */

const commands = {
  getFov: vi.fn((): ViewportFov => ({ value: 60, min: 40, max: 120 })),
  setFov: vi.fn(),
  onCameraChanged: vi.fn((handler: () => void) => {
    commands.emitCameraChanged = handler;
    return () => {
      commands.emitCameraChanged = null;
    };
  }),
  emitCameraChanged: null as (() => void) | null,
};

const wrappers: Array<ReturnType<typeof mount>> = [];
let workspace: ReturnType<typeof createWorkspace>;

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

function mountControl() {
  workspace = createWorkspace(fakeClient());
  const wrapper = mount(OrbitControl, {
    global: {
      provide: { [workspaceKey as symbol]: workspace },
      plugins: [createRefinoI18n("zh")],
    },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  return wrapper;
}

/** One slider row of the panel, found by its label. */
function row(wrapper: VueWrapper, label: string): VueWrapper {
  const block = wrapper
    .findAll(".setting")
    .find((candidate) => candidate.find(".label").text() === label);
  if (block === undefined) throw new Error(`no setting row ${label}`);
  return block;
}

function slide(wrapper: VueWrapper, label: string, value: number): void {
  row(wrapper, label).findComponent(NSlider).vm.$emit("update:value", value);
}

async function expand(wrapper: VueWrapper): Promise<void> {
  await wrapper.find("button").trigger("click");
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  commands.getFov.mockReturnValue({ value: 60, min: 40, max: 120 });
  setViewportCommands(commands as never);
});

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount();
  workspace?.stop();
  setViewportCommands(null);
});

describe("OrbitControl panel", () => {
  it("groups every orbit setting behind one button", async () => {
    const wrapper = mountControl();
    expect(wrapper.find(".panel").exists()).toBe(false);
    await expand(wrapper);
    expect(wrapper.findAll(".group-title").map((title) => title.text())).toEqual([
      "相机",
      "星光",
      "流光",
      "文字",
      "物理模拟",
      "行星公转",
    ]);
    expect(wrapper.findAllComponents(NSlider)).toHaveLength(9);
  });

  it("stays usable for the persisted rows without registered camera commands", async () => {
    setViewportCommands(null);
    const wrapper = mountControl();
    await expand(wrapper);
    slide(wrapper, "星星亮度", 0.8);
    expect(workspace.state.config.orbitStarBrightness).toBe(0.8);
  });

  it("shows the current field of view and drives the camera through the bridge", async () => {
    const wrapper = mountControl();
    await expand(wrapper);
    expect(row(wrapper, "视场角").find(".value").text()).toBe("60°");
    slide(wrapper, "视场角", 90);
    expect(commands.setFov).toHaveBeenLastCalledWith(90);
    // The scene reports the angle it is heading for.
    commands.getFov.mockReturnValue({ value: 90, min: 40, max: 120 });
    commands.emitCameraChanged?.();
    await vi.waitFor(() => expect(row(wrapper, "视场角").find(".value").text()).toBe("90°"));
  });

  it("resets the field of view to the scene default", async () => {
    const wrapper = mountControl();
    await expand(wrapper);
    await row(wrapper, "视场角").find(".reset").trigger("click");
    expect(commands.setFov).toHaveBeenLastCalledWith(100);
  });

  it("writes the rotation sensitivity and persists it under its own key", async () => {
    const wrapper = mountControl();
    await expand(wrapper);
    expect(workspace.state.config.rotateSensitivity).toBe(2);
    slide(wrapper, "旋转灵敏度", 0.5);
    expect(workspace.state.config.rotateSensitivity).toBe(0.5);
    expect(localStorage.getItem("refino.canvas.rotateSensitivity")).toBe("0.5");
    // The reset only enables after the row re-renders with the new value.
    await wrapper.vm.$nextTick();
    await row(wrapper, "旋转灵敏度").find(".reset").trigger("click");
    expect(workspace.state.config.rotateSensitivity).toBe(2);
  });

  it("persists the light, flow, text, physics and revolution rows", async () => {
    const wrapper = mountControl();
    await expand(wrapper);
    slide(wrapper, "星星亮度", 1.4);
    slide(wrapper, "流速", 2.2);
    slide(wrapper, "亮度", 0.4);
    slide(wrapper, "字号", 1.2);
    slide(wrapper, "弹簧劲度", 1.5);
    slide(wrapper, "斥力", 0.8);
    slide(wrapper, "转速", 0);
    expect(workspace.state.config.orbitStarBrightness).toBe(1.4);
    expect(workspace.state.config.orbitFlowSpeed).toBe(2.2);
    expect(workspace.state.config.orbitFlowGlow).toBe(0.4);
    expect(workspace.state.config.orbitTextScale).toBe(1.2);
    expect(workspace.state.config.orbitSpring).toBe(1.5);
    expect(workspace.state.config.orbitRepulsion).toBe(0.8);
    expect(workspace.state.config.orbitRevolutionSpeed).toBe(0);
    expect(localStorage.getItem("refino.canvas.orbitFlowSpeed")).toBe("2.2");
  });

  it("reads persisted values on the next mount and resets a row to its baseline", async () => {
    localStorage.setItem("refino.canvas.rotateSensitivity", "3.5");
    localStorage.setItem("refino.canvas.orbitStarBrightness", "0.5");
    const wrapper = mountControl();
    await expand(wrapper);
    expect(workspace.state.config.rotateSensitivity).toBe(3.5);
    expect(row(wrapper, "旋转灵敏度").find(".value").text()).toBe("3.50×");
    await row(wrapper, "星星亮度").find(".reset").trigger("click");
    expect(workspace.state.config.orbitStarBrightness).toBe(1);
  });

  it("offers the reset only while a row sits off its baseline", async () => {
    const wrapper = mountControl();
    await expand(wrapper);
    expect(row(wrapper, "星星亮度").find(".reset").attributes("disabled")).toBeDefined();
    slide(wrapper, "星星亮度", 0.6);
    await wrapper.vm.$nextTick();
    expect(row(wrapper, "星星亮度").find(".reset").attributes("disabled")).toBeUndefined();
  });
});
