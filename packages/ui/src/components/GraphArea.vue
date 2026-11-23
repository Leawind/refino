<script setup lang="ts">
// The canvas pane: the WebGL graph host plus everything floating over it —
// the edge controls (via the float manifest). The cursor-following peek card
// belongs to the planar canvas only: the orbit view reads its body from the
// hovered star's own summary label instead. Owns the host's render-culling
// feedback, which the status pill reads from the shared render state.
import { computed, defineAsyncComponent, watch } from "vue";
import DecisionGraph from "./DecisionGraph.vue";
import GraphFloats from "./GraphFloats.vue";
import NodePeek from "./NodePeek.vue";
// three.js is only needed in the orbit view; keep it out of the initial
// bundle and load the scene with the view switch.
const OrbitView = defineAsyncComponent(() => import("./OrbitView.vue"));
import { injectRequired } from "../context";
import { renderCulled } from "../renderStatus";
import { workspaceKey } from "../workspace";

const workspace = injectRequired(workspaceKey, "workspace");

const orbit = computed(() => workspace.state.config.canvasView === "orbit");

function onRenderCulled(value: boolean): void {
  renderCulled.value = value;
}

// The orbit view never culls; do not let the planar canvas's last status
// linger in the status pill after switching views.
watch(orbit, (value) => {
  if (value) renderCulled.value = false;
});
</script>

<template>
  <div class="graph-area">
    <DecisionGraph
      v-if="!orbit"
      :direction="workspace.state.config.direction"
      :layout-mode="workspace.state.config.layoutMode"
      @render-culled="onRenderCulled"
    />
    <OrbitView v-else />
    <GraphFloats />
    <NodePeek v-if="!orbit" />
  </div>
</template>

<style scoped>
.graph-area {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
