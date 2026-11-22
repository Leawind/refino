<script setup lang="ts">
// Canvas minimap (ui DESIGN.md, "视口"): an overview of the whole working
// set plus the visible viewport rectangle, drawn on a small 2D canvas from
// the renderer's overview snapshots. Click or drag navigates (centers the
// viewport), the wheel zooms. Collapsible; the preference persists in the
// canvas config. All data and actions ride the viewport bridge, so the
// widget stays inert until a canvas registers its commands.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { NIcon } from "naive-ui";
import { MapOutline, CloseOutline } from "@vicons/ionicons5";
import { injectRequired } from "../context";
import { readThemeColors } from "../graph/render/renderer";
import {
  fitProjection,
  toMap,
  toVirtual,
  unionRects,
  visibleRect,
  type OverviewProjection,
  type OverviewSnapshot,
} from "../graph/render/overview";
import { storeKey } from "../store";
import { viewportBridge } from "../viewportBridge";
import { workspaceKey } from "../workspace";

const { t } = useI18n();
const workspace = injectRequired(workspaceKey, "workspace");
const store = injectRequired(storeKey, "store");

const MAP_WIDTH = 200;
const MAP_HEIGHT = 140;
const MAP_PADDING = 8;

const collapsed = computed({
  get: () => !workspace.state.config.showMinimap,
  set: (value: boolean) => workspace.setConfig({ showMinimap: !value }),
});

const canvasEl = ref<HTMLCanvasElement | null>(null);
let projection: OverviewProjection | null = null;
let unsubscribe: (() => void) | null = null;
let frame: number | 0 = 0;

function draw(): void {
  frame = 0;
  const canvas = canvasEl.value;
  const commands = viewportBridge.commands;
  if (canvas === null || commands === null) return;
  const snapshot: OverviewSnapshot | null = commands.getOverview();
  // The projection survives without a 2D context: navigation (click/drag)
  // needs it even where drawing is impossible (e.g. test environments).
  projection = null;
  if (snapshot === null) return;
  const visible = visibleRect(snapshot);
  const content = unionRects([
    visible,
    ...snapshot.nodes.map((node) => ({
      minX: node.x,
      minY: node.y,
      maxX: node.x + node.width,
      maxY: node.y + node.height,
    })),
  ]);
  if (content === null) return;
  projection = fitProjection(content, { width: MAP_WIDTH, height: MAP_HEIGHT }, MAP_PADDING);

  const ctx = canvas.getContext("2d");
  if (ctx === null) return;

  const theme = readThemeColors();
  const toCss = (value: [number, number, number, number]): string =>
    `rgba(${value.map((channel) => Math.round(channel * 255)).join(",")})`;
  ctx.fillStyle = toCss(theme.canvasBg);
  ctx.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

  // Node rects: premise capsules fade toward the canvas like on the real
  // canvas (a flat alpha step is enough at this size).
  for (const node of snapshot.nodes) {
    const p = toMap(projection, node.x, node.y);
    ctx.fillStyle = toCss(node.premise ? theme.edge : theme.nodeBorder);
    ctx.globalAlpha = node.premise ? 0.35 : 0.55;
    ctx.fillRect(
      p.x,
      p.y,
      Math.max(1, node.width * projection.scale),
      Math.max(1, node.height * projection.scale),
    );
  }
  ctx.globalAlpha = 1;

  // The viewport rectangle: primary outline over the map.
  const topLeft = toMap(projection, visible.minX, visible.minY);
  const width = (visible.maxX - visible.minX) * projection.scale;
  const height = (visible.maxY - visible.minY) * projection.scale;
  ctx.strokeStyle = toCss(theme.primary);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(topLeft.x, topLeft.y, width, height);
}

function requestDraw(): void {
  if (frame !== 0) return;
  // Environments without rAF (test DOM) draw synchronously; the browser
  // coalesces high-frequency camera frames onto the next animation frame.
  if (typeof window.requestAnimationFrame !== "function") {
    draw();
    return;
  }
  frame = requestAnimationFrame(draw);
}

function navigate(event: MouseEvent): void {
  const canvas = canvasEl.value;
  if (canvas === null || projection === null || viewportBridge.commands === null) return;
  const rect = canvas.getBoundingClientRect();
  const point = toVirtual(projection, event.clientX - rect.left, event.clientY - rect.top);
  viewportBridge.commands.centerOn(point.x, point.y);
}

let dragging = false;

function onPointerDown(event: MouseEvent): void {
  dragging = true;
  navigate(event);
}

function onPointerMove(event: MouseEvent): void {
  if (dragging) navigate(event);
}

function onPointerUp(): void {
  dragging = false;
}

function onWheel(event: WheelEvent): void {
  event.preventDefault();
  viewportBridge.commands?.zoomBy(Math.exp(-event.deltaY * 0.0015));
}

function resubscribe(): void {
  unsubscribe?.();
  unsubscribe = null;
  if (viewportBridge.commands === null) return;
  unsubscribe = viewportBridge.commands.onCameraChanged(requestDraw);
  requestDraw();
}

watch(() => viewportBridge.commands, resubscribe, { immediate: true });
// Scene changes (working set growth, layout updates) redraw too.
watch(() => workspace.displayed.value, requestDraw);
watch(() => store.state.theme, requestDraw);

onMounted(() => {
  window.addEventListener("pointerup", onPointerUp);
  requestDraw();
});
onBeforeUnmount(() => {
  window.removeEventListener("pointerup", onPointerUp);
  unsubscribe?.();
  if (frame !== 0) cancelAnimationFrame(frame);
});
</script>

<template>
  <div v-if="!collapsed" class="minimap">
    <button class="head" :title="t('canvas.minimapClose')" @click="collapsed = true">
      <span>{{ t("canvas.minimap") }}</span>
      <NIcon :component="CloseOutline" :size="12" />
    </button>
    <canvas
      ref="canvasEl"
      class="map"
      :width="MAP_WIDTH"
      :height="MAP_HEIGHT"
      @pointerdown.prevent="onPointerDown"
      @pointermove="onPointerMove"
      @wheel.prevent="onWheel"
    />
  </div>
  <button v-else class="restorer" :title="t('canvas.minimap')" @click="collapsed = false">
    <NIcon :component="MapOutline" />
  </button>
</template>

<style scoped>
.minimap {
  display: flex;
  flex-direction: column;
  border-radius: var(--refino-radius);
  background: var(--refino-surface);
  border: 1px solid var(--refino-border);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11px;
  padding: 4px 8px;
  cursor: pointer;
  opacity: 0.7;
}

.head:hover {
  opacity: 1;
}

.map {
  display: block;
  cursor: crosshair;
}

.restorer {
  display: inline-flex;
  border: none;
  background: var(--refino-surface);
  color: inherit;
  border: 1px solid var(--refino-border);
  border-radius: var(--refino-radius);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
  padding: 5px;
  cursor: pointer;
}

.restorer:hover {
  opacity: 1;
}
</style>
