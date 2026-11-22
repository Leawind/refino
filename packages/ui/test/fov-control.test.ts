// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { NSlider } from "naive-ui";
import FovControl from "../src/components/FovControl.vue";
import { createRefinoI18n } from "../src/i18n";
import { setViewportCommands } from "../src/viewportBridge";
import type { ViewportFov } from "../src/viewportBridge";

/**
 * The orbit field-of-view control (ui DESIGN.md, "三维视图"): a bottom-right
 * button expands a slider for the narrower viewing angle. The value rides the
 * viewport bridge and the readout follows camera frames.
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

function mountControl() {
  const wrapper = mount(FovControl, {
    global: { plugins: [createRefinoI18n("zh")] },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  commands.getFov.mockReturnValue({ value: 60, min: 40, max: 120 });
  setViewportCommands(commands as never);
});

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount();
  setViewportCommands(null);
});

describe("FovControl", () => {
  it("stays inert without registered viewport commands", () => {
    setViewportCommands(null);
    const wrapper = mountControl();
    expect(wrapper.find("button").attributes("disabled")).toBeDefined();
    expect(wrapper.find(".panel").exists()).toBe(false);
  });

  it("expands a slider showing the current field of view", async () => {
    const wrapper = mountControl();
    expect(wrapper.find(".panel").exists()).toBe(false);
    await wrapper.find("button").trigger("click");
    expect(wrapper.find(".panel").exists()).toBe(true);
    expect(wrapper.find(".panel .value").text()).toBe("60°");
  });

  it("resets the angle to the scene default", async () => {
    const wrapper = mountControl();
    await wrapper.find("button").trigger("click");
    const reset = wrapper.findAll(".panel button").find((button) => button.text() === "重置视场角");
    expect(reset).toBeDefined();
    await reset!.trigger("click");
    expect(commands.setFov).toHaveBeenLastCalledWith(45);
  });

  it("drives the camera through the bridge and follows camera frames", async () => {
    const wrapper = mountControl();
    await wrapper.find("button").trigger("click");
    wrapper.findComponent(NSlider).vm.$emit("update:value", 90);
    expect(commands.setFov).toHaveBeenLastCalledWith(90);
    // The scene reports the angle it is heading for.
    commands.getFov.mockReturnValue({ value: 90, min: 40, max: 120 });
    commands.emitCameraChanged?.();
    await vi.waitFor(() => expect(wrapper.find(".panel .value").text()).toBe("90°"));
  });
});
