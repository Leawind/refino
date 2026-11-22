<script setup lang="ts">
// Floating layer anchored to an edge or corner of the decision graph pane.
// Any control that should hover over the graph (direction switch, status
// pill, future tools) mounts inside one of these instead of positioning
// itself, so placements stay consistent.
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
  top: 4px;
  left: 4px;
}

.top-right {
  top: 4px;
  right: 4px;
  flex-direction: column;
}

.bottom-left {
  bottom: 4px;
  left: 4px;
}

.bottom-right {
  bottom: 4px;
  right: 4px;
  flex-direction: column;
}
</style>
