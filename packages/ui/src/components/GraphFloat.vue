<script setup lang="ts">
// Floating layer anchored to an edge of the decision graph pane. Any control
// that should hover over the graph mounts inside one of these instead of
// positioning itself, so placements stay consistent.
import type { FloatPlacement } from "../types";

const props = defineProps<{
  placement: FloatPlacement;
}>();
</script>

<template>
  <div class="graph-float" :class="props.placement">
    <slot />
  </div>
</template>

<style scoped>
.graph-float {
  position: absolute;
  z-index: 5;
  display: flex;
  gap: 8px;
  pointer-events: none;
}

.graph-float > * {
  pointer-events: auto;
}

.top-left {
  top: 8px;
  left: 8px;
}

/* The selection trail can outgrow the pane: it stays centred and truncates
 * instead of pushing against the corner controls. The width leaves the
 * minimap's column free so the two never overlap. */
.top-center {
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  max-width: min(calc(100% - 240px), 760px);
}

.top-right {
  top: 8px;
  right: 8px;
  flex-direction: column;
}

.bottom-left {
  bottom: 8px;
  left: 8px;
}

.bottom-right {
  bottom: 8px;
  right: 8px;
  flex-direction: column;
  align-items: flex-end;
}
</style>
