import { beforeEach, describe, expect, it } from "vitest";
import { closePalette, openPalette, paletteState, togglePalette } from "../src/palette";

/** The palette open state is a module singleton every surface drives
 * (header button, shortcut); the component only reacts to it. */
describe("palette singleton", () => {
  beforeEach(() => {
    closePalette();
  });

  it("opens, closes and toggles", () => {
    expect(paletteState.open).toBe(false);
    openPalette();
    expect(paletteState.open).toBe(true);
    togglePalette();
    expect(paletteState.open).toBe(false);
    togglePalette();
    expect(paletteState.open).toBe(true);
    closePalette();
    expect(paletteState.open).toBe(false);
  });
});
