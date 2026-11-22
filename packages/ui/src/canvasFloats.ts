import type { Component } from "vue";
import CanvasControls from "./components/CanvasControls.vue";
import CanvasMinimap from "./components/CanvasMinimap.vue";
import SelectionList from "./components/SelectionList.vue";
import StatusPill from "./components/StatusPill.vue";
import type { CanvasView, FloatPlacement } from "./types";

/**
 * The canvas edge controls (ui DESIGN.md, "布局"): each float is a
 * self-contained component plus the corner it mounts in. Adding a control
 * means adding its component and one entry here — nothing else changes.
 *
 * A static manifest, not a runtime registry: every control is first-party
 * and known at compile time, so registration stays type-checked and
 * tree-shakeable. GraphFloats.vue is the single renderer. Controls that
 * only make sense on the planar canvas declare their views and disappear
 * in the orbit view.
 */
export interface CanvasFloat {
  placement: FloatPlacement;
  component: Component;
  /** Views the control appears in; absent = every view. */
  views?: readonly CanvasView[];
}

export const canvasFloats: CanvasFloat[] = [
  { placement: "top-left", component: CanvasMinimap, views: ["planar"] },
  { placement: "top-right", component: SelectionList },
  // One grouped control: its rows hide the planar-only pieces themselves.
  { placement: "bottom-right", component: CanvasControls },
  { placement: "bottom-left", component: StatusPill },
];

export type CanvasFloatGroups = Record<FloatPlacement, Component[]>;

/** The manifest grouped by corner, preserving registration order within a
 * corner: one float layer per corner, not per control. A corner whose
 * controls are all hidden by the current view renders no layer. */
export function canvasFloatGroups(view: CanvasView): CanvasFloatGroups {
  const groups: CanvasFloatGroups = {
    "top-left": [],
    "top-right": [],
    "bottom-left": [],
    "bottom-right": [],
  };
  for (const float of canvasFloats) {
    if (float.views !== undefined && !float.views.includes(view)) continue;
    groups[float.placement].push(float.component);
  }
  return groups;
}
