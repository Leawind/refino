<script setup lang="ts">
// Zoom controls (ui DESIGN.md, "视口"): zoom out / live percentage (click
// resets to 100%) / zoom in / fit view / fit selection, stacked in the
// bottom-right float corner like the other canvas edge controls. All actions
// ride the viewport bridge; the widget renders inert until a canvas
// registers its commands.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { NIcon } from "naive-ui";
import { RemoveOutline, AddOutline, ExpandOutline, SquareOutline } from "@vicons/ionicons5";
import { viewportBridge } from "../viewportBridge";

const { t } = useI18n();

const ZOOM_STEP = 1.25;

const scale = ref(1);
let unsubscribe: (() => void) | null = null;

watch(
  () => viewportBridge.commands,
  (commands) => {
    unsubscribe?.();
    unsubscribe = null;
    if (commands === null) return;
    // Camera movement frames carry the current snapshot; idle frames don't
    // run, so the readout is free.
    unsubscribe = commands.onCameraChanged(() => {
      const current = viewportBridge.commands?.getOverview() ?? null;
      if (current !== null) scale.value = current.camera.scale;
    });
  },
  { immediate: true },
);

onBeforeUnmount(() => unsubscribe?.());

const percent = computed(() => `${Math.round(scale.value * 100)}%`);

function zoom(factor: number): void {
  viewportBridge.commands?.zoomBy(factor);
}

function reset(): void {
  if (scale.value > 0) viewportBridge.commands?.zoomBy(1 / scale.value);
}
</script>

<template>
  <div class="zoom-controls" :class="{ disabled: viewportBridge.commands === null }">
    <button class="btn" :title="t('app.zoomOut')" @click="zoom(1 / ZOOM_STEP)">
      <NIcon :component="RemoveOutline" />
    </button>
    <button class="btn percent" :title="t('app.zoomReset')" @click="reset">{{ percent }}</button>
    <button class="btn" :title="t('app.zoomIn')" @click="zoom(ZOOM_STEP)">
      <NIcon :component="AddOutline" />
    </button>
    <span class="divider" />
    <button class="btn" :title="t('app.fitView')" @click="viewportBridge.commands?.fitView()">
      <NIcon :component="ExpandOutline" />
    </button>
    <button
      class="btn"
      :title="t('app.fitSelection')"
      @click="viewportBridge.commands?.fitSelection()"
    >
      <NIcon :component="SquareOutline" />
    </button>
  </div>
</template>

<style scoped>
.zoom-controls {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px 6px;
  font-size: 12px;
  border-radius: var(--refino-radius);
  background: var(--refino-surface);
  border: 1px solid var(--refino-border);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
}

/* Inert until a canvas registers its commands. Dim the glyphs instead of the
 * whole surface: the bar must stay opaque over the canvas as well. */
.zoom-controls.disabled {
  color: rgba(128, 128, 128, 0.8);
}

.btn {
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  padding: 2px 6px;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.btn:hover {
  background: rgba(128, 128, 128, 0.15);
}

.percent {
  min-width: 44px;
  font-variant-numeric: tabular-nums;
}

.divider {
  width: 1px;
  height: 16px;
  background: var(--refino-border);
  margin: 0 3px;
}
</style>
