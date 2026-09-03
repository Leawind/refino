<script setup lang="ts">
// Floating layer anchored to an edge or corner of the decision graph pane.
// Any control that should hover over the graph (direction switch, status
// pill, future tools) mounts inside one of these instead of positioning
// itself, so placements stay consistent.
const props = defineProps<{
  placement: "top-left" | "top-right" | "bottom-left" | "bottom-right";
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
  top: 12px;
  left: 12px;
}

.top-right {
  top: 12px;
  right: 12px;
  flex-direction: column;
}

.bottom-left {
  bottom: 12px;
  left: 12px;
}

.bottom-right {
  bottom: 12px;
  right: 12px;
  flex-direction: column;
}
</style>
