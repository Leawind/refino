// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { installAltTracking, peekHide, peekMove, peekState } from "../src/peek";

/** Alt-peek tracking (ui DESIGN.md, "交互"): the modifier drives the card,
 * leaving the node, releasing Alt and Esc all dismiss it. */

let remove: (() => void) | null = null;

function key(key: string, init: KeyboardEventInit = {}): void {
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
  );
}

afterEach(() => {
  remove?.();
  remove = null;
  peekHide();
  peekState.alt = false;
});

describe("installAltTracking", () => {
  it("hides the card on Escape while Alt is still held", () => {
    remove = installAltTracking();
    key("Alt");
    peekMove("A1B2C3D4", 120, 80);
    expect(peekState.alt).toBe(true);
    expect(peekState.id).toBe("A1B2C3D4");

    key("Escape");
    expect(peekState.id).toBeNull();
    expect(peekState.alt).toBe(true);
  });

  it("stops tracking on cleanup", () => {
    remove = installAltTracking();
    remove();
    remove = null;
    key("Alt");
    expect(peekState.alt).toBe(false);
  });
});
