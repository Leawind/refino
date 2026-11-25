<script setup lang="ts">
// Bottom-right canvas controls, laid out along the two edges that meet at
// the corner (ui DESIGN.md, "布局"): the corner itself holds the view switch
// — the one control that changes what the canvas *is* — with the square
// buttons stacked up the right edge above it and the wide bars running left
// along the bottom. Every control therefore touches an edge; nothing floats
// in the canvas interior.
import { computed } from "vue";
import { injectRequired } from "../context";
import { workspaceKey } from "../workspace";
import CanvasStyleSettings from "./CanvasStyleSettings.vue";
import OrbitControl from "./OrbitControl.vue";
import LayoutControls from "./LayoutControls.vue";
import NodeSizeControl from "./NodeSizeControl.vue";
import ViewToggle from "./ViewToggle.vue";
import ZoomControls from "./ZoomControls.vue";

const workspace = injectRequired(workspaceKey, "workspace");

const orbit = computed(() => workspace.state.config.canvasView === "orbit");
</script>

<template>
  <div class="canvas-controls">
    <!-- Square controls climb the right edge, closest to the corner first. -->
    <div class="stack">
      <NodeSizeControl v-if="!orbit" />
      <CanvasStyleSettings v-if="!orbit" />
      <OrbitControl v-if="orbit" />
    </div>
    <!-- Wide controls run left along the bottom edge, nearest the corner last. -->
    <div class="strip">
      <LayoutControls v-if="!orbit" />
      <ZoomControls />
      <ViewToggle />
    </div>
  </div>
</template>

<style scoped>
.canvas-controls {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

.stack {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

.strip {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
