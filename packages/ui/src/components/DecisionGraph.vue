<script setup lang="ts">
// Center canvas: layered CRG visualization. Clicking a node selects it.
// Pan/zoom and richer in-canvas interactions are intentionally out of scope.
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { store } from "../store";
import { layoutGraph } from "../graph/layout";
import type { LayoutDirection } from "../types";

const props = defineProps<{ direction: LayoutDirection }>();

const { t } = useI18n();

const geometry = computed(() => layoutGraph(store.state.nodes, props.direction));

function labelOf(id: string): string {
  const node = store.state.nodes.find((n) => n.id === id);
  const summary = node?.summary ?? "";
  return summary === "" ? t("node.untitled") : summary;
}

function truncate(text: string): string {
  // Chinese summaries are wide; cap by display width, not char count.
  return [...text].length > 12 ? `${[...text].slice(0, 11).join("")}…` : text;
}

function nodeType(id: string): string | undefined {
  return store.state.nodes.find((n) => n.id === id)?.type;
}
</script>

<template>
  <div class="canvas">
    <svg
      v-if="geometry.nodes.length > 0"
      :width="geometry.width"
      :height="geometry.height"
      :viewBox="`0 0 ${geometry.width} ${geometry.height}`"
    >
      <g class="edges">
        <path v-for="(edge, i) in geometry.edges" :key="i" :d="edge.path" class="edge" />
      </g>
      <g
        v-for="node in geometry.nodes"
        :key="node.id"
        class="node"
        :class="[nodeType(node.id), { selected: node.id === store.state.selectedId }]"
        @click="store.select(node.id)"
        @dblclick="store.openDetail()"
      >
        <rect :x="node.x" :y="node.y" :width="node.width" :height="node.height" rx="8" />
        <text class="id" :x="node.x + 10" :y="node.y + 17">{{ node.id }}</text>
        <text class="summary" :x="node.x + 10" :y="node.y + 34">
          {{ truncate(labelOf(node.id)) }}
        </text>
      </g>
    </svg>
    <p v-else class="empty">{{ t("node.emptySelection") }}</p>
  </div>
</template>

<style scoped>
.canvas {
  width: 100%;
  height: 100%;
  overflow: auto;
  user-select: none;
}

/* The svg keeps a 1:1 user-unit scale; large graphs scroll within the pane. */

.empty {
  display: grid;
  place-items: center;
  height: 100%;
  opacity: 0.5;
}

.edge {
  fill: none;
  stroke: var(--refino-edge);
  stroke-width: 1.4;
}

.node rect {
  fill: var(--refino-node-bg);
  stroke: var(--refino-node-border);
  stroke-width: 1.2;
  cursor: pointer;
}

.node:hover rect {
  stroke: var(--refino-primary, #18a058);
}

.node.selected rect {
  stroke: var(--refino-primary, #18a058);
  stroke-width: 2.4;
  fill: rgba(24, 160, 88, 0.12);
}

.node text {
  font-size: 11px;
  fill: currentColor;
  pointer-events: none;
}

.node .id {
  font-family: monospace;
  opacity: 0.7;
}

.node.premise rect {
  stroke-dasharray: 4 3;
}
</style>
