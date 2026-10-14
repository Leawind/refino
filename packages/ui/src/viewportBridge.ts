import { reactive } from "vue";
import type { OverviewSnapshot } from "./graph/render/overview";

/**
 * Viewport command seam (ui DESIGN.md, "视口"): zoom and fit commands are
 * exposed to global shortcuts and the palette, and the minimap reads its
 * overview data through here, but the camera lives in the renderer instance
 * inside the canvas component. A module singleton mirrors
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
  /** Center the viewport on a virtual point (minimap navigation). */
  centerOn(vx: number, vy: number): void;
  /** Overview snapshot for the minimap; null while empty. */
  getOverview(): OverviewSnapshot | null;
  /** Subscribe to camera/scene movement (minimap redraw); returns the
   * unsubscribe function. */
  onCameraChanged(handler: () => void): () => void;
}

export const viewportBridge = reactive<{ commands: ViewportCommands | null }>({
  commands: null,
});

export function setViewportCommands(commands: ViewportCommands | null): void {
  viewportBridge.commands = commands;
}
