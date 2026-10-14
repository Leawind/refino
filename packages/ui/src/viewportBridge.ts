import { reactive } from "vue";

/**
 * Viewport command seam (ui DESIGN.md, "视口"): zoom and fit commands are
 * exposed to global shortcuts and the palette, but the camera lives in the
 * renderer instance inside the canvas component. A module singleton mirrors
 * `peek.ts`/`palette.ts`: the canvas registers implementations on mount and
 * clears them on unmount; callers go through the bridge and do nothing when
 * no canvas is mounted.
 */
export interface ViewportCommands {
  /** Multiplicative zoom around the viewport center. */
  zoomBy(factor: number): void;
  /** Fit the whole working set into the viewport. */
  fitView(): void;
  /** Fit the selected nodes into the viewport. */
  fitSelection(): void;
}

export const viewportBridge = reactive<{ commands: ViewportCommands | null }>({
  commands: null,
});

export function setViewportCommands(commands: ViewportCommands | null): void {
  viewportBridge.commands = commands;
}
