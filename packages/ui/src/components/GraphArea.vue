<script setup lang="ts">
// The canvas pane: the WebGL graph host plus everything floating over it —
// the edge controls (via the float manifest) and the cursor-following peek
// card. Owns the host's render-culling feedback, which the status pill
// reads from the shared render state.
import DecisionGraph from "./DecisionGraph.vue";
import GraphFloats from "./GraphFloats.vue";
import NodePeek from "./NodePeek.vue";
import { injectRequired } from "../context";
import { renderCulled } from "../renderStatus";
import { workspaceKey } from "../workspace";

const workspace = injectRequired(workspaceKey, "workspace");

function onRenderCulled(value: boolean): void {
  renderCulled.value = value;
}
</script>

<template>
  <div class="graph-area">
    <DecisionGraph
      :direction="workspace.state.config.direction"
      :layout-mode="workspace.state.config.layoutMode"
      @render-culled="onRenderCulled"
    />
    <GraphFloats />
    <NodePeek />
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
