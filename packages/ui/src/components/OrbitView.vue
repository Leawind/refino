<script setup lang="ts">
// Orbit view (ui DESIGN.md, "三维视图"): decisions as a constellation around
// the virtual root, premises as satellites of the decisions they ground.
// Right drag turns the ball, the wheel changes the camera distance, left
// click selects and makes the clicked star the orbit center (Ctrl/Cmd
// toggles, Shift range-selects), left drag moves a decision inside the plane
// through it that faces the camera, the virtual root is clickable too, double
// click opens the editor, right click without dragging opens the context
// menu. Hover shows the summary and feeds the Alt-peek card; the focused
// star's content floats in a free spot of the picture (OrbitCallout); the
// same viewport bridge as the planar canvas serves zoom, fit and shortcuts.
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { injectRequired } from "../context";
import { peekHide, peekMove } from "../peek";
import { storeKey } from "../store";
import { workspaceKey } from "../workspace";
import { setViewportCommands } from "../viewportBridge";
import type { OverviewSnapshot } from "../graph/render/overview";
import { buildOrbitScene } from "../graph/orbit/data";
import { ORBIT_ROOT_ID, OrbitScene } from "../graph/orbit/scene";
import type { OrbitPick } from "../graph/orbit/scene";
import type { NodeType } from "../types";
import CanvasContextMenu from "./CanvasContextMenu.vue";
import OrbitCallout from "./OrbitCallout.vue";

const store = injectRequired(storeKey, "store");
const workspace = injectRequired(workspaceKey, "workspace");
const { t } = useI18n();

const hostEl = ref<HTMLElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);
const failed = ref(false);
const hoverInfo = ref<{
  summary: string;
  type: NodeType;
  left: number;
  top: number;
} | null>(null);

/** The scene instance, once WebGL is up; the callout overlay reads its
 * screen geometry through it. */
const scene = shallowRef<OrbitScene | null>(null);
/** The orbit center's target, mirrored from the scene for the callout. */
const focus = shallowRef<{ key: string; id: string | null } | null>(null);
let resizeObserver: ResizeObserver | null = null;
let signature = "";
let hadNodes = false;
let hoveredId: string | null = null;
/** An external focus may name a node that the working set has not loaded
 * yet; retry when the scene next receives data. */
let pendingFocusId: string | null = null;
/** Bridge subscribers (zoom readout, FOV control): the scene keeps a single
 * camera listener, so the view fans movement out to all of them. */
const cameraHandlers = new Set<() => void>();

/** Tooltip width cap in CSS pixels, kept in step with the style below. */
const TIP_WIDTH = 240;
const TIP_MAX_HEIGHT = 72;
const TIP_OFFSET = 16;

const byId = computed(
  () => new Map(workspace.displayed.value.map((node) => [node.id, node] as const)),
);
/** The focused star's node; null for the virtual root and empty space. */
const focusedNode = computed(() => {
  const id = focus.value?.id;
  return id === null || id === undefined ? null : (byId.value.get(id) ?? null);
});
/** Summaries for the premise labels around the focused decision. */
const summaries = computed(
  () =>
    new Map(
      workspace.displayed.value.map(
        (node) => [node.id, node.summary === "" ? t("node.untitled") : node.summary] as const,
      ),
    ),
);

function rebuild(fit: boolean): void {
  const current = scene.value;
  if (current === null) return;
  const displayed = workspace.displayed.value;
  const data = buildOrbitScene(displayed);
  if (!fit && data.signature === signature) return;
  signature = data.signature;
  const firstContent = !hadNodes && data.nodes.length > 0;
  hadNodes = data.nodes.length > 0;
  current.setData(data.nodes, data.satellites, data.edges, fit || firstContent);
  applyPendingFocus();
}

function applyPendingFocus(): void {
  if (pendingFocusId === null) return;
  if (scene.value?.focusOnNode(pendingFocusId) ?? false) pendingFocusId = null;
}

function ensureScene(): void {
  const host = hostEl.value;
  const canvas = canvasEl.value;
  if (scene.value !== null || host === null || canvas === null) return;
  const created = OrbitScene.create(canvas);
  if (created === null) {
    failed.value = true;
    return;
  }
  scene.value = created;
  created.resize(host.clientWidth, host.clientHeight);
  created.setState(new Set(workspace.state.selection), workspace.state.hoveredId);
  created.onCameraChanged(() => {
    for (const handler of cameraHandlers) handler();
  });
  created.onFocusChanged(() => {
    focus.value = created.focus;
  });
  focus.value = created.focus;
  setViewportCommands({
    zoomBy: (factor) => scene.value?.zoomBy(factor),
    fitView: () => scene.value?.fitView(),
    fitSelection: () => {
      const selection = workspace.state.selection;
      if (selection.length === 0) {
        scene.value?.fitView();
        return;
      }
      scene.value?.fitSelection(selection);
      // One selected star owns the new centre; keep its content in view. A
      // group frames a centroid that no single star can stand for.
      if (selection.length === 1) scene.value?.focusOnNode(selection[0]!);
    },
    // The minimap is planar-only; nothing navigates orbit space by plane
    // coordinates.
    centerOn: () => {},
    getOverview: (): OverviewSnapshot | null => {
      const current = scene.value;
      return current === null
        ? null
        : {
            nodes: [],
            camera: { scale: current.scale, tx: 0, ty: 0 },
            viewport: current.viewport,
          };
    },
    onCameraChanged: (handler) => {
      cameraHandlers.add(handler);
      return () => {
        cameraHandlers.delete(handler);
      };
    },
    getFov: () => scene.value?.fov ?? null,
    setFov: (fov) => scene.value?.setFov(fov),
  });
  resizeObserver = new ResizeObserver(() => {
    if (host === null) return;
    scene.value?.resize(host.clientWidth, host.clientHeight);
  });
  resizeObserver.observe(host);
  rebuild(true);
}

function localPoint(event: { clientX: number; clientY: number }): { x: number; y: number } {
  const rect = canvasEl.value?.getBoundingClientRect();
  if (rect === undefined) return { x: 0, y: 0 };
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function pick(event: MouseEvent): OrbitPick | null {
  const current = scene.value;
  if (current === null) return null;
  const point = localPoint(event);
  return current.pick(point.x, point.y);
}

function clampTip(event: MouseEvent): { left: number; top: number } {
  const host = hostEl.value;
  const point = localPoint(event);
  const maxLeft = (host?.clientWidth ?? 0) - TIP_WIDTH - TIP_OFFSET;
  const maxTop = (host?.clientHeight ?? 0) - TIP_MAX_HEIGHT - TIP_OFFSET;
  return {
    left: Math.max(TIP_OFFSET, Math.min(point.x + TIP_OFFSET, maxLeft)),
    top: Math.max(TIP_OFFSET, Math.min(point.y + TIP_OFFSET, maxTop)),
  };
}

function hideHover(): void {
  if (hoveredId !== null) peekHide(hoveredId);
  hoveredId = null;
  hoverInfo.value = null;
  scene.value?.setRootHover(false);
  workspace.unhover();
}

function setCursor(cursor: string): void {
  const canvas = canvasEl.value;
  if (canvas !== null) canvas.style.cursor = cursor;
}

function updateHover(event: MouseEvent): void {
  const hit = pick(event);
  const id = hit?.id ?? null;
  const overRoot = hit !== null && hit.id === null;
  scene.value?.setRootHover(overRoot);
  if (id === hoveredId) {
    if (id !== null) {
      peekMove(id, event.clientX, event.clientY);
      if (hoverInfo.value !== null) {
        const point = clampTip(event);
        hoverInfo.value.left = point.left;
        hoverInfo.value.top = point.top;
      }
    }
    // Both the root and empty space have no node id, so the cursor must be
    // decided from the pick rather than from the hovered id.
    setCursor(id !== null || overRoot ? "pointer" : "default");
    return;
  }
  if (hoveredId !== null) peekHide(hoveredId);
  hoveredId = id;
  if (id === null) {
    hoverInfo.value = null;
    workspace.unhover();
    // The virtual root is clickable; empty space is not.
    setCursor(overRoot ? "pointer" : "default");
    return;
  }
  const node = byId.value.get(id);
  workspace.hover(id);
  peekMove(id, event.clientX, event.clientY);
  if (node !== undefined) {
    const point = clampTip(event);
    hoverInfo.value = {
      summary: node.summary === "" ? t("node.untitled") : node.summary,
      type: node.type,
      left: point.left,
      top: point.top,
    };
  }
  setCursor("pointer");
}

let press: { x: number; y: number; button: number } | null = null;
let rightDragged = false;
/** Left press that may turn into a node drag once it moves far enough. */
let dragPress: {
  id: string;
  x: number;
  y: number;
  pointerId: number;
  active: boolean;
} | null = null;

function onPointerDown(event: PointerEvent): void {
  press = { x: event.clientX, y: event.clientY, button: event.button };
  if (event.button === 2) rightDragged = false;
  menu.open = false;
  if (event.button === 0) {
    const hit = pick(event);
    // Only decisions own a body in the force layout; premise satellites stay
    // where their ring puts them.
    dragPress =
      hit !== null && hit.id !== null && byId.value.get(hit.id)?.type === "decision"
        ? {
            id: hit.id,
            x: event.clientX,
            y: event.clientY,
            pointerId: event.pointerId,
            active: false,
          }
        : null;
  }
}

function onPointerMove(event: PointerEvent): void {
  if (press !== null) {
    const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    if (moved > 4 && press.button === 2) {
      rightDragged = true;
      menu.open = false;
    }
  }
  if (dragPress !== null) {
    if ((event.buttons & 1) === 0) {
      dragPress = null;
    } else if (dragPress.active) {
      const point = localPoint(event);
      scene.value?.dragTo(point.x, point.y);
      return;
    } else if (Math.hypot(event.clientX - dragPress.x, event.clientY - dragPress.y) > 4) {
      // The plane passes through the star's position at the start of the
      // drag, so it stays perpendicular to the view for the whole gesture.
      const start = localPoint({ clientX: dragPress.x, clientY: dragPress.y });
      if (scene.value?.beginDrag(dragPress.id, start.x, start.y) ?? false) {
        dragPress.active = true;
        canvasEl.value?.setPointerCapture?.(dragPress.pointerId);
        hideHover();
        setCursor("grabbing");
        const point = localPoint(event);
        scene.value?.dragTo(point.x, point.y);
        return;
      }
      dragPress = null;
    }
  }
  // Right drag turns the view: freeze the hover instead of lighting up
  // whatever sphere slides under the cursor.
  if ((event.buttons & 2) !== 0) {
    hideHover();
    setCursor("grabbing");
    return;
  }
  updateHover(event);
}

function onPointerUp(event: PointerEvent): void {
  const gesture = press;
  press = null;
  if (dragPress !== null) {
    const dragging = dragPress.active;
    if (dragging) {
      scene.value?.endDrag();
      setCursor("default");
    }
    dragPress = null;
    if (dragging) return;
  }
  if (event.button === 2) {
    // Keep `rightDragged` for the context menu that follows on mouse-up;
    // the next right press resets it.
    setCursor("default");
    return;
  }
  if (gesture === null || event.button !== 0) return;
  if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 4) return;
  const hit = pick(event);
  if (hit === null) {
    if (!event.shiftKey) workspace.clearSelection();
    return;
  }
  if (hit.id === null) {
    // The virtual root is a focus target, not a selectable node.
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) workspace.clearSelection();
    scene.value?.focusOn(ORBIT_ROOT_ID);
    return;
  }
  const node = byId.value.get(hit.id);
  if (node === undefined) return;
  const toggle = event.ctrlKey || event.metaKey;
  const wasSelected = workspace.state.selection.includes(hit.id);
  if (event.shiftKey) void workspace.rangeSelect(node);
  else if (toggle) workspace.toggle(node);
  else workspace.select(node);
  // A click that leaves the star selected also makes it the orbit center;
  // Ctrl/Cmd-clicking a selected star only removes it from the selection.
  if (!toggle || !wasSelected) scene.value?.focusOn(hit.key);
}

function onPointerLeave(): void {
  // A captured drag keeps its pointer moves even outside the canvas.
  if (dragPress?.active === true) return;
  hideHover();
  setCursor("default");
}

function onPointerCancel(): void {
  if (dragPress?.active === true) scene.value?.endDrag();
  dragPress = null;
  setCursor("default");
}

/** The canvas context menu: a right press released in place (a right drag
 * rotated the view instead). */
const menu = reactive<{ open: boolean; x: number; y: number; nodeId: string | null }>({
  open: false,
  x: 0,
  y: 0,
  nodeId: null,
});

function onContextMenu(event: MouseEvent): void {
  event.preventDefault();
  if (rightDragged) {
    rightDragged = false;
    return;
  }
  menu.x = event.clientX;
  menu.y = event.clientY;
  menu.nodeId = pick(event)?.id ?? null;
  menu.open = true;
}

function onDoubleClick(event: MouseEvent): void {
  const hit = pick(event);
  if (hit === null) store.startCreate("decision");
  else if (hit.id !== null) store.openDetail(hit.id);
}

onMounted(() => {
  ensureScene();
});

watch(
  () => workspace.displayed.value,
  () => rebuild(false),
);
watch(
  () => [workspace.state.selection, workspace.state.hoveredId] as const,
  ([selection, hovered]) => scene.value?.setState(new Set(selection), hovered),
);
// A "locate" from the resource list, selection list, palette or review drawer
// changes only the shared focus. Bring the orbit center there too; a plain
// click inside the canvas has already focused the star and is a no-op here.
watch(
  () => workspace.state.focusId,
  (id) => {
    pendingFocusId = id;
    applyPendingFocus();
  },
);

onBeforeUnmount(() => {
  setViewportCommands(null);
  cameraHandlers.clear();
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (hoveredId !== null) peekHide(hoveredId);
  hoveredId = null;
  workspace.unhover();
  scene.value?.dispose();
  scene.value = null;
  focus.value = null;
});
</script>

<template>
  <div ref="hostEl" class="orbit">
    <canvas
      ref="canvasEl"
      class="orbit-canvas"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointerleave="onPointerLeave"
      @pointercancel="onPointerCancel"
      @contextmenu="onContextMenu"
      @dblclick="onDoubleClick"
    />
    <div
      v-if="hoverInfo !== null"
      class="hover-tip"
      :style="{ left: `${hoverInfo.left}px`, top: `${hoverInfo.top}px` }"
    >
      <span class="kind">{{ t(`node.${hoverInfo.type}`) }}</span>
      <span class="summary">{{ hoverInfo.summary }}</span>
    </div>
    <OrbitCallout v-if="scene !== null" :scene="scene" :node="focusedNode" :summaries="summaries" />
    <CanvasContextMenu
      v-if="menu.open"
      :x="menu.x"
      :y="menu.y"
      :node-id="menu.nodeId"
      @close="menu.open = false"
    />
    <p v-if="failed" class="empty">{{ t("canvas.glUnavailable") }}</p>
  </div>
</template>

<style scoped>
.orbit {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  user-select: none;
  /* The orbit view is a small planetarium: a fixed deep-space backdrop
   * keeps stars readable in both UI themes. */
  background: #05070f;
  background:
    radial-gradient(ellipse at 50% 42%, rgba(36, 58, 110, 0.45), transparent 55%),
    radial-gradient(circle at 50% 45%, #0a1022 0%, #05070f 58%, #020308 100%);
}

.orbit-canvas {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  outline: none;
  touch-action: none;
}

.hover-tip {
  position: absolute;
  z-index: 6;
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: max-content;
  max-width: 240px;
  padding: 4px 8px;
  font-size: 12px;
  line-height: 1.45;
  border: 1px solid var(--refino-border);
  border-radius: 6px;
  background: var(--refino-surface);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
  pointer-events: none;
}

.kind {
  flex: none;
  opacity: 0.55;
}

.summary {
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow-wrap: anywhere;
}

.empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  margin: 0;
  color: rgba(214, 230, 255, 0.7);
  pointer-events: none;
}
</style>
