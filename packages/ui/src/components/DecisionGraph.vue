<script setup lang="ts">
// Center canvas: the working set rendered by the WebGL2 batch renderer
// (README, "画布"): nodes, edges and labels draw on the GPU with the render
// budget culling over-budget parts; floating controls stay DOM. Clicking a
// node selects it, shift+click range-selects, ctrl+click toggles, double
// click opens the detail bar, hovering pulls in the node's direct grounds.
// The camera here fits the working-set bounding box; stable virtual space,
// pan/zoom and fly-to-focus land with the viewport milestone.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { store } from "../store";
import { workspace } from "../workspace";
import { layoutGraph } from "../graph/layout";
import {
  CULL_FOCUS,
  CULL_GROUND_OF_HOVERED,
  CULL_GROUND_OF_SELECTED,
  CULL_HOVERED,
  CULL_OTHER,
  CULL_SELECTED,
  createAdaptiveBudget,
  hardwareFactor,
} from "../graph/render/budget";
import type { AdaptiveBudget } from "../graph/render/budget";
import { GraphRenderer, readThemeColors } from "../graph/render/renderer";
import type { RenderEdgeInput, RenderNodeInput, SceneInput } from "../graph/render/renderer";
import type { LayoutDirection, NodeLite } from "../types";

const props = defineProps<{ direction: LayoutDirection }>();

const emit = defineEmits<{ renderCulled: [culled: boolean] }>();

const { t } = useI18n();

const canvasEl = ref<HTMLCanvasElement | null>(null);
const glFailed = ref(false);
let renderer: GraphRenderer | null = null;
let budget: AdaptiveBudget | null = null;

const geometry = computed(() => layoutGraph(workspace.displayed.value, props.direction));
const byId = computed(() => new Map(workspace.displayed.value.map((n) => [n.id, n] as const)));

/** Display list with render priority classes and per-node styling flags. */
const scene = computed<SceneInput>(() => {
  const { selection, focusId, hoveredId } = workspace.state;
  const selectionSet = new Set(selection);
  const hovered = hoveredId !== null ? byId.value.get(hoveredId) : undefined;
  const positions = new Map(geometry.value.nodes.map((n) => [n.id, n] as const));
  const selectedCenters = selection.flatMap((id) => {
    const node = positions.get(id);
    return node === undefined ? [] : [{ x: node.x + node.width / 2, y: node.y + node.height / 2 }];
  });
  const groundsOf = (nodes: Array<NodeLite | undefined>): Set<string> => {
    const grounds = new Set<string>();
    for (const node of nodes) {
      if (node?.type !== "constraint") continue;
      for (const ground of node.grounds ?? []) grounds.add(ground);
    }
    return grounds;
  };
  const groundsOfSelected = groundsOf([...selectionSet].map((id) => byId.value.get(id)));
  const groundsOfHovered = groundsOf([hovered]);
  const distanceToSelection = (node: { x: number; y: number; width: number; height: number }) => {
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;
    let best = Infinity;
    for (const center of selectedCenters) {
      best = Math.min(best, Math.hypot(cx - center.x, cy - center.y));
    }
    return best;
  };

  const nodes: RenderNodeInput[] = [];
  const displayedIds = new Set<string>();
  for (const lite of workspace.displayed.value) {
    const node = positions.get(lite.id);
    if (node === undefined) continue;
    displayedIds.add(lite.id);
    const cls =
      lite.id === focusId
        ? CULL_FOCUS
        : selectionSet.has(lite.id)
          ? CULL_SELECTED
          : lite.id === hoveredId
            ? CULL_HOVERED
            : lite.type === "premise" && groundsOfSelected.has(lite.id)
              ? CULL_GROUND_OF_SELECTED
              : lite.type === "premise" && groundsOfHovered.has(lite.id)
                ? CULL_GROUND_OF_HOVERED
                : CULL_OTHER;
    nodes.push({
      id: lite.id,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      rounded: lite.type === "constraint",
      label: lite.summary === "" ? t("node.untitled") : lite.summary,
      selected: selectionSet.has(lite.id),
      focus: lite.id === focusId,
      hovered: lite.id === hoveredId,
      cls,
      distance: distanceToSelection(node),
      fadeIn: cls === CULL_GROUND_OF_HOVERED,
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
  return { nodes, edges };
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
  renderer.setTheme(readThemeColors());
  renderer.setScene(scene.value);
}

onMounted(ensureRenderer);

watch(scene, (value) => renderer?.setScene(value));
watch(
  () => store.state.theme,
  () => renderer?.setTheme(readThemeColors()),
);
watch(
  () => [workspace.state.config.budgetMode, workspace.state.config.budgetManual] as const,
  () => syncBudget(),
);

onBeforeUnmount(() => {
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
  const id = pickAt(event);
  if (id === null) return;
  const lite = byId.value.get(id);
  if (lite === undefined) return;
  if (event.shiftKey) void workspace.rangeSelect(lite);
  else if (event.ctrlKey || event.metaKey) workspace.toggle(lite);
  else workspace.select(lite);
}

function onDoubleClick(event: MouseEvent): void {
  if (pickAt(event) !== null) store.openDetail();
}

let hoveredNode: string | null = null;

function onMouseMove(event: MouseEvent): void {
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
