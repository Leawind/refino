import { reactive } from "vue";

/**
 * Command palette open state (ui DESIGN.md, "布局"): the palette is the
 * single entry point for node search and global actions, opened from any
 * surface — the header button, Ctrl/Cmd+K, embedders. A module singleton
 * mirrors `peek.ts`: one palette instance, driven by everyone.
 */
export const paletteState = reactive({ open: false });

export function openPalette(): void {
  paletteState.open = true;
}

export function closePalette(): void {
  paletteState.open = false;
}

export function togglePalette(): void {
  paletteState.open = !paletteState.open;
}
