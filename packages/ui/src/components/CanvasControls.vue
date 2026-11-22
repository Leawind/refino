<script setup lang="ts">
// Bottom-right canvas controls as compact rows (ui DESIGN.md, "布局"):
// style, node size and layout belong to the planar canvas; the view switch
// stays next to the zoom bar so no row is left half empty, in either view,
// and the orbit view adds its field-of-view control in the same row.
import { computed } from "vue";
import { injectRequired } from "../context";
import { workspaceKey } from "../workspace";
import CanvasStyleSettings from "./CanvasStyleSettings.vue";
import FovControl from "./FovControl.vue";
import LayoutControls from "./LayoutControls.vue";
import NodeSizeControl from "./NodeSizeControl.vue";
import ViewToggle from "./ViewToggle.vue";
import ZoomControls from "./ZoomControls.vue";

const workspace = injectRequired(workspaceKey, "workspace");

const orbit = computed(() => workspace.state.config.canvasView === "orbit");
</script>

<template>
  <div class="canvas-controls">
    <div v-if="!orbit" class="row">
      <CanvasStyleSettings />
      <NodeSizeControl />
      <LayoutControls />
    </div>
    <div class="row">
      <ViewToggle />
      <ZoomControls />
      <FovControl v-if="orbit" />
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

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
