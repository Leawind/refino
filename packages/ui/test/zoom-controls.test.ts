// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createRefinoI18n } from "../src/i18n";
import { setViewportCommands, viewportBridge } from "../src/viewportBridge";
import ZoomControls from "../src/components/ZoomControls.vue";
import type { OverviewSnapshot } from "../src/graph/render/overview";

/**
 * The zoom controls (ui DESIGN.md, "视口"): all actions ride the viewport
 * bridge, the percentage tracks the camera and clicking it resets to 100%.
 */

const handlers = {
  zoomBy: vi.fn(),
  fitView: vi.fn(),
  fitSelection: vi.fn(),
  centerOn: vi.fn(),
  getOverview: vi.fn((): OverviewSnapshot | null => ({
    nodes: [],
    camera: { scale: 1.5, tx: 0, ty: 0 },
    viewport: { width: 800, height: 600 },
  })),
  onCameraChanged: vi.fn((handler: () => void) => {
    handlers.emitCameraChanged = handler;
    return () => {
      handlers.emitCameraChanged = null;
    };
  }),
  emitCameraChanged: null as (() => void) | null,
};

const wrappers: Array<ReturnType<typeof mount>> = [];

function mountControls() {
  const wrapper = mount(ZoomControls, {
    global: { plugins: [createRefinoI18n("zh")] },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  setViewportCommands(handlers as never);
});

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount();
  setViewportCommands(null);
});

describe("ZoomControls", () => {
  it("renders inert without registered viewport commands", () => {
    setViewportCommands(null);
    const wrapper = mountControls();
    expect(wrapper.find(".zoom-controls.disabled").exists()).toBe(true);
  });

  it("zooms by steps and resets via the percentage", async () => {
    mountControls();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".zoom-controls .btn")];
    buttons[0]!.click();
    expect(handlers.zoomBy).toHaveBeenLastCalledWith(1 / 1.25);
    buttons[2]!.click();
    expect(handlers.zoomBy).toHaveBeenLastCalledWith(1.25);
    // The percentage reads the snapshot's camera scale via a camera frame.
    handlers.emitCameraChanged?.();
    await vi.waitFor(() => expect(buttons[1]!.textContent).toContain("150"));
    buttons[1]!.click();
    expect(handlers.zoomBy).toHaveBeenLastCalledWith(1 / 1.5);
  });

  it("triggers fit view and fit selection", () => {
    mountControls();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".zoom-controls .btn")];
    buttons[3]!.click();
    expect(handlers.fitView).toHaveBeenCalledTimes(1);
    buttons[4]!.click();
    expect(handlers.fitSelection).toHaveBeenCalledTimes(1);
  });

  it("keeps the percentage live through camera-changed frames", async () => {
    mountControls();
    handlers.getOverview.mockReturnValue({
      nodes: [],
      camera: { scale: 0.75, tx: 0, ty: 0 },
      viewport: { width: 800, height: 600 },
    });
    handlers.emitCameraChanged?.();
    await vi.waitFor(() => {
      expect(document.querySelector(".percent")?.textContent).toContain("75");
    });
    expect(viewportBridge.commands).not.toBeNull();
  });
});
