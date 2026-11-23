import type { Component } from "vue";
import CanvasControls from "./components/CanvasControls.vue";
import CanvasMinimap from "./components/CanvasMinimap.vue";
import CanvasStatus from "./components/CanvasStatus.vue";
import SelectionTrail from "./components/SelectionTrail.vue";
import type { CanvasView, FloatPlacement } from "./types";

/**
 * The canvas edge controls (ui DESIGN.md, "布局"): each float is a
 * self-contained component plus the edge it mounts along. Adding a control
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
  // The selection is a path through the map, so it rides the top edge.
  { placement: "top-center", component: SelectionTrail },
  // One grouped control: its rows hide the planar-only pieces themselves.
  { placement: "bottom-right", component: CanvasControls },
  { placement: "bottom-left", component: CanvasStatus },
];

export type CanvasFloatGroups = Record<FloatPlacement, Component[]>;

/** The manifest grouped by edge, preserving registration order within an
 * edge: one float layer per edge, not per control. An edge whose controls
 * are all hidden by the current view renders no layer. */
export function canvasFloatGroups(view: CanvasView): CanvasFloatGroups {
  const groups: CanvasFloatGroups = {
    "top-left": [],
    "top-center": [],
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
