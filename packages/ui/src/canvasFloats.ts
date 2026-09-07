import type { Component } from "vue";
import CanvasStyleSettings from "./components/CanvasStyleSettings.vue";
import LayoutControls from "./components/LayoutControls.vue";
import NodeSizeControl from "./components/NodeSizeControl.vue";
import SelectionList from "./components/SelectionList.vue";
import StatusPill from "./components/StatusPill.vue";
import type { FloatPlacement } from "./types";

/**
 * The canvas edge controls (ui DESIGN.md, "布局"): each float is a
 * self-contained component plus the corner it mounts in. Adding a control
 * means adding its component and one entry here — nothing else changes.
 *
 * A static manifest, not a runtime registry: every control is first-party
 * and known at compile time, so registration stays type-checked and
 * tree-shakeable. GraphFloats.vue is the single renderer.
 */
export interface CanvasFloat {
  placement: FloatPlacement;
  component: Component;
}

export const canvasFloats: CanvasFloat[] = [
  { placement: "top-right", component: SelectionList },
  { placement: "bottom-right", component: CanvasStyleSettings },
  { placement: "bottom-right", component: NodeSizeControl },
  { placement: "bottom-right", component: LayoutControls },
  { placement: "bottom-left", component: StatusPill },
];

export type CanvasFloatGroups = Record<FloatPlacement, Component[]>;

/** The manifest grouped by corner, preserving registration order within a
 * corner: one float layer per corner, not per control. */
export const canvasFloatGroups: CanvasFloatGroups = canvasFloats.reduce(
  (groups, float) => {
    groups[float.placement].push(float.component);
    return groups;
  },
  { "top-left": [], "top-right": [], "bottom-left": [], "bottom-right": [] } as CanvasFloatGroups,
);
