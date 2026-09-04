<script setup lang="ts">
// Center canvas: the working set rendered by the WebGL2 batch renderer
// (README, "画布"): nodes, edges and labels draw on the GPU with the render
// budget culling over-budget parts; floating controls stay DOM. Clicking a
// node selects it, shift+click range-selects, ctrl+click toggles, double
// click opens the detail bar, hovering pulls in the node's direct grounds.
// The layout is recomputed from scratch on every working-set change; the
// camera keeps the focus node at a stable screen position — clicking a node
// never displaces it — flying only for an off-screen or newly joining
// focus, and re-fitting on direction flips.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { injectRequired } from "../context";
import { storeKey } from "../store";
import { workspaceKey } from "../workspace";

const store = injectRequired(storeKey, "store");
const workspace = injectRequired(workspaceKey, "workspace");
import { createLayoutSession } from "../graph/layout/registry";
import type { LaidOutNode, LayoutSession } from "../graph/layout/types";
import type { LayoutMode } from "../graph/layout/types";
import {
  CULL_FOCUS,
  CULL_HOVERED,
  CULL_OTHER,
  CULL_SELECTED,
  createAdaptiveBudget,
  hardwareFactor,
} from "../graph/render/budget";
import type { AdaptiveBudget } from "../graph/render/budget";
import { GraphRenderer, readThemeColors } from "../graph/render/renderer";
import type { RenderEdgeInput, RenderNodeInput, SceneInput } from "../graph/render/renderer";
import type { LayoutDirection } from "../types";

const props = defineProps<{ direction: LayoutDirection; layoutMode: LayoutMode }>();

const emit = defineEmits<{ renderCulled: [culled: boolean] }>();

const { t } = useI18n();

const canvasEl = ref<HTMLCanvasElement | null>(null);
const glFailed = ref(false);
let renderer: GraphRenderer | null = null;
let budget: AdaptiveBudget | null = null;

// The layout session is (re)created from the displayed subgraph whenever
// it, the mode or the direction changes; converging sessions step from a
// requestAnimationFrame loop until settled, snapshot layouts finish at
// creation. The camera keeps the focus node in place.
const layout = ref<LaidOutNode[]>([]);
let session: LayoutSession | null = null;
let rafId = 0;
let lastFrame = 0;

function stopSession(): void {
  if (rafId !== 0) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  session?.dispose();
  session = null;
}

function startSession(): void {
  stopSession();
  session = createLayoutSession(props.layoutMode, workspace.displayed.value, {
    direction: props.direction,
  });
  layout.value = [...session.positions()];
  if (!session.animating) return;
  lastFrame = performance.now();
  const tick = (now: number): void => {
    const current = session;
    if (current === null) return;
    layout.value = [...current.step(now - lastFrame)];
    lastFrame = now;
    if (current.animating) rafId = requestAnimationFrame(tick);
    else rafId = 0;
  };
  rafId = requestAnimationFrame(tick);
}

watch(
  () => [workspace.displayed.value, props.direction, props.layoutMode] as const,
  () => startSession(),
  { immediate: true },
);

const byId = computed(() => new Map(workspace.displayed.value.map((n) => [n.id, n] as const)));

/** Display list with render priority classes and per-node styling flags. */
const scene = computed<SceneInput>(() => {
  const { selection, focusId, hoveredId } = workspace.state;
  const selectionSet = new Set(selection);
  const positions = new Map(layout.value.map((n) => [n.id, n] as const));
  const distanceToSelection = (node: { x: number; y: number; width: number; height: number }) => {
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;
    let best = Infinity;
    for (const id of selectionSet) {
      const center = positions.get(id);
      if (center === undefined) continue;
      best = Math.min(
        best,
        Math.hypot(cx - (center.x + center.width / 2), cy - (center.y + center.height / 2)),
      );
    }
    return best;
  };

  const nodes: RenderNodeInput[] = [];
  const displayedIds = new Set<string>();
  for (const lite of workspace.displayed.value) {
    const node = positions.get(lite.id);
    if (node === undefined) continue;
    displayedIds.add(lite.id);
    nodes.push({
      id: lite.id,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      label: lite.summary === "" ? t("node.untitled") : lite.summary,
      selected: selectionSet.has(lite.id),
      focus: lite.id === focusId,
      hovered: lite.id === hoveredId,
      cls:
        lite.id === focusId
          ? CULL_FOCUS
          : selectionSet.has(lite.id)
            ? CULL_SELECTED
            : lite.id === hoveredId
              ? CULL_HOVERED
              : CULL_OTHER,
      distance: distanceToSelection(node),
    });
  }
  const edges: RenderEdgeInput[] = [];
  for (const lite of workspace.displayed.value) {
    if (lite.type !== "constraint") continue;
    for (const ground of lite.grounds ?? []) {
      if (!displayedIds.has(ground)) continue;
      edges.push({ fromId: ground, toId: lite.id, emphasized: lite.id === hoveredId });
    }
  }
  return { nodes, edges, focusId };
});

function syncBudget(): void {
  budget?.setOptions({
    mode: workspace.state.config.budgetMode,
    manualBudget: workspace.state.config.budgetManual,
  });
  renderer?.requestRender();
}

function ensureRenderer(): void {
  const canvas = canvasEl.value;
  if (canvas === null || renderer !== null) return;
  budget = createAdaptiveBudget(
    {
      mode: workspace.state.config.budgetMode,
      manualBudget: workspace.state.config.budgetManual,
    },
    { width: canvas.clientWidth, height: canvas.clientHeight },
    hardwareFactor(navigator.hardwareConcurrency),
  );
  renderer = GraphRenderer.create(canvas, budget);
  if (renderer === null) {
    glFailed.value = true;
    return;
  }
  renderer.onFrameEnd = (info) => emit("renderCulled", info.culled);
  renderer.setZoomAnchor(workspace.state.config.zoomAnchor);
  renderer.setMaxScale(workspace.state.config.zoomMax);
  renderer.setTheme(readThemeColors());
  renderer.setScene(scene.value);
}

onMounted(ensureRenderer);

watch(scene, (value) => renderer?.setScene(value));
// setScene keeps the focus placed (README: 相机随焦点). Direction flips
// re-fit the whole working set.
watch(
  () => props.direction,
  () => renderer?.fitToContent(),
);
watch(
  () => [workspace.state.config.zoomAnchor, workspace.state.config.zoomMax] as const,
  ([anchor, max]) => {
    renderer?.setZoomAnchor(anchor);
    renderer?.setMaxScale(max);
    renderer?.requestRender();
  },
);
watch(
  () => store.state.theme,
  () => renderer?.setTheme(readThemeColors()),
);
watch(
  () => [workspace.state.config.budgetMode, workspace.state.config.budgetManual] as const,
  () => syncBudget(),
);

onBeforeUnmount(() => {
  stopSession();
  renderer?.dispose();
  renderer = null;
  budget = null;
});

function pickAt(event: MouseEvent): string | null {
  const canvas = canvasEl.value;
  if (canvas === null || renderer === null) return null;
  const rect = canvas.getBoundingClientRect();
  return renderer.pick(event.clientX - rect.left, event.clientY - rect.top);
}

function onClick(event: MouseEvent): void {
  // A left press that moved beyond the click slop was a pan, not a click.
  if (renderer?.clickSuppressed === true) return;
  const id = pickAt(event);
  if (id === null) return;
  const lite = byId.value.get(id);
  if (lite === undefined) return;
  if (event.shiftKey) void workspace.rangeSelect(lite);
  else if (event.ctrlKey || event.metaKey) workspace.toggle(lite);
  else workspace.select(lite);
}

function onDoubleClick(event: MouseEvent): void {
  const id = pickAt(event);
  if (id !== null) store.openDetail(id);
}

let hoveredNode: string | null = null;

function onMouseMove(event: MouseEvent): void {
  // While panning, hover follows the grab — freeze it instead of lighting
  // up whatever slides under the cursor.
  if (renderer?.dragging === true) return;
  const id = pickAt(event);
  if (id === hoveredNode) return;
  hoveredNode = id;
  if (id === null) workspace.unhover();
  else workspace.hover(id);
  if (canvasEl.value !== null) canvasEl.value.style.cursor = id === null ? "default" : "pointer";
}

function onMouseLeave(): void {
  hoveredNode = null;
  workspace.unhover();
}
</script>

<template>
  <div class="canvas">
    <canvas
      ref="canvasEl"
      class="gl"
      @click="onClick"
      @dblclick="onDoubleClick"
      @mousemove="onMouseMove"
      @mouseleave="onMouseLeave"
    />
    <p v-if="glFailed" class="empty">{{ t("canvas.glUnavailable") }}</p>
    <p v-else-if="scene.nodes.length === 0" class="empty">{{ t("node.emptySelection") }}</p>
  </div>
</template>

<style scoped>
.canvas {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  user-select: none;
  /* The canvas surface sits a step below the panels and the opaque node
   * cards drawn on it (token drives the WebGL palette too). */
  background: var(--refino-canvas-bg);
}

.gl {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}

.empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  margin: 0;
  opacity: 0.5;
  pointer-events: none;
}
</style>
