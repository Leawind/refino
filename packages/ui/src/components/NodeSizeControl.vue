<script setup lang="ts">
// Node size control: a small edge button that expands into a rectangle
// sized exactly like the node card — the expanded rectangle is the control
// itself, and dragging its corner handles resizes the shared card size live
// (ui DESIGN.md, "交互"). The value persists through the workspace canvas
// config like every other setting.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { NButton } from "naive-ui";
import { injectRequired } from "../context";
import { NODE_SIZE_DEFAULT, NODE_SIZE_MAX, NODE_SIZE_MIN, workspaceKey } from "../workspace";

const { t } = useI18n();

const workspace = injectRequired(workspaceKey, "workspace");

const open = ref(false);
const root = ref<HTMLElement | null>(null);
/** True while a corner handle is being dragged (disables the morph ease). */
const resizing = ref(false);

const width = computed(() => workspace.state.config.nodeWidth);
const height = computed(() => workspace.state.config.nodeHeight);
/** The W×H caption needs room; tiny cards skip it. */
const showDims = computed(() => width.value >= 72 && height.value >= 24);

const CORNERS = ["nw", "ne", "sw", "se"] as const;
type Corner = (typeof CORNERS)[number];

/** One handle drag: the grabbed corner follows the pointer, the opposite
 * corner stays fixed. */
interface ResizeGesture {
  corner: Corner;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
}
let gesture: ResizeGesture | null = null;

const clampSize = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

function onHandleDown(corner: Corner, event: MouseEvent): void {
  // Keep the outside-click collapse from seeing this press.
  event.stopPropagation();
  gesture = {
    corner,
    startX: event.clientX,
    startY: event.clientY,
    startWidth: width.value,
    startHeight: height.value,
  };
  resizing.value = true;
  window.addEventListener("mousemove", onResizeMove);
  window.addEventListener("mouseup", onResizeUp);
}

function onResizeMove(event: MouseEvent): void {
  if (gesture === null) return;
  const west = gesture.corner === "nw" || gesture.corner === "sw";
  const north = gesture.corner === "nw" || gesture.corner === "ne";
  workspace.setConfig({
    nodeWidth: clampSize(
      Math.round(
        gesture.startWidth +
          (west ? gesture.startX - event.clientX : event.clientX - gesture.startX),
      ),
      NODE_SIZE_MIN.width,
      NODE_SIZE_MAX.width,
    ),
    nodeHeight: clampSize(
      Math.round(
        gesture.startHeight +
          (north ? gesture.startY - event.clientY : event.clientY - gesture.startY),
      ),
      NODE_SIZE_MIN.height,
      NODE_SIZE_MAX.height,
    ),
  });
}

function onResizeUp(): void {
  gesture = null;
  resizing.value = false;
  window.removeEventListener("mousemove", onResizeMove);
  window.removeEventListener("mouseup", onResizeUp);
}

/** Any press outside the control collapses it back to the button. */
function onDocumentDown(event: MouseEvent): void {
  if (root.value !== null && event.target instanceof Node && !root.value.contains(event.target)) {
    open.value = false;
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") open.value = false;
}

watch(open, (value) => {
  if (value) {
    document.addEventListener("mousedown", onDocumentDown);
    window.addEventListener("keydown", onKeydown);
  } else {
    document.removeEventListener("mousedown", onDocumentDown);
    window.removeEventListener("keydown", onKeydown);
    onResizeUp(); // never leak a live gesture
  }
});

onBeforeUnmount(() => {
  onResizeUp();
  document.removeEventListener("mousedown", onDocumentDown);
  window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <div ref="root" class="node-size">
    <!-- The expanded rectangle IS the control: the button grows into it. -->
    <div
      v-if="open"
      class="card"
      :class="{ resizing }"
      :style="{ width: `${width}px`, height: `${height}px` }"
    >
      <span v-if="showDims" class="dims">{{ width }} × {{ height }}</span>
      <button
        v-for="corner in CORNERS"
        :key="corner"
        type="button"
        class="handle"
        :class="corner"
        :title="t('canvas.nodeSizeResize')"
        @mousedown="onHandleDown(corner, $event)"
      />
    </div>
    <NButton v-else circle :title="t('canvas.nodeSize')" @click="open = true"> ⤢ </NButton>
    <NButton
      v-if="open"
      quaternary
      size="tiny"
      @click="
        workspace.setConfig({
          nodeWidth: NODE_SIZE_DEFAULT.width,
          nodeHeight: NODE_SIZE_DEFAULT.height,
        })
      "
    >
      {{ t("canvas.nodeSizeReset") }}
    </NButton>
  </div>
</template>

<style scoped>
.node-size {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

/* The expanded card is 1:1 with the virtual node (1 unit = 1 CSS px) and
 * grows out of the button's corner; the width/height ease only applies to
 * the expand/collapse morph, never to a live drag. */
.card {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  border: 1.2px solid var(--refino-border);
  border-radius: 8px;
  background: var(--refino-surface);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
  transform-origin: bottom right;
  animation: node-size-expand 0.15s ease-out;
  transition:
    width 0.15s ease,
    height 0.15s ease;
}

.card.resizing {
  transition: none;
}

@keyframes node-size-expand {
  from {
    transform: scale(0.2);
    opacity: 0.4;
  }

  to {
    transform: scale(1);
    opacity: 1;
  }
}

.dims {
  font-size: 11px;
  font-family: monospace;
  white-space: nowrap;
  opacity: 0.75;
  pointer-events: none;
}

.handle {
  position: absolute;
  width: 10px;
  height: 10px;
  padding: 0;
  border: 1px solid var(--refino-border);
  border-radius: 2px;
  background: var(--refino-surface);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
}

.handle.nw {
  top: -5px;
  left: -5px;
  cursor: nwse-resize;
}

.handle.ne {
  top: -5px;
  right: -5px;
  cursor: nesw-resize;
}

.handle.sw {
  bottom: -5px;
  left: -5px;
  cursor: nesw-resize;
}

.handle.se {
  bottom: -5px;
  right: -5px;
  cursor: nwse-resize;
}
</style>
