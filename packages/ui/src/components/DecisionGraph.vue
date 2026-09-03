<script setup lang="ts">
// Center canvas: renders the on-demand working set. Clicking a node makes it
// the sole selection; shift+click range-selects; ctrl+click toggles; double
// click opens the detail window; hovering pulls in the node's direct
// grounds. The SVG renderer is a placeholder for the WebGL canvas
// (README, "画布": rendering and incremental layout land separately).
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { store } from "../store";
import { workspace } from "../workspace";
import { layoutGraph } from "../graph/layout";
import type { LayoutDirection, NodeLite } from "../types";

const props = defineProps<{ direction: LayoutDirection }>();

const { t } = useI18n();

const geometry = computed(() => layoutGraph(workspace.displayed.value, props.direction));
const byId = computed(() => new Map(workspace.displayed.value.map((n) => [n.id, n] as const)));

function labelOf(id: string): string {
  return byId.value.get(id)?.summary ?? "";
}

function truncate(text: string): string {
  // Chinese summaries are wide; cap by display width, not char count.
  return [...text].length > 12 ? `${[...text].slice(0, 11).join("")}…` : text;
}

function onClick(event: MouseEvent, lite: NodeLite | undefined): void {
  if (lite === undefined) return;
  if (event.shiftKey) void workspace.rangeSelect(lite);
  else if (event.ctrlKey || event.metaKey) workspace.toggle(lite);
  else workspace.select(lite);
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
        <path
          v-for="(edge, i) in geometry.edges"
          :key="i"
          :d="edge.path"
          class="edge"
          :class="{ strong: edge.to.id === workspace.state.hoveredId }"
        />
      </g>
      <g
        v-for="node in geometry.nodes"
        :key="node.id"
        class="node"
        :class="[
          byId.get(node.id)?.type,
          {
            selected: workspace.state.selection.includes(node.id),
            focus: node.id === workspace.state.focusId,
            hovered: node.id === workspace.state.hoveredId,
          },
        ]"
        @click="onClick($event, byId.get(node.id))"
        @dblclick="store.openDetail()"
        @mouseenter="workspace.hover(node.id)"
        @mouseleave="workspace.unhover()"
      >
        <rect
          :x="node.x"
          :y="node.y"
          :width="node.width"
          :height="node.height"
          :rx="byId.get(node.id)?.type === 'premise' ? 0 : 8"
        />
        <text class="summary" :x="node.x + 10" :y="node.y + 26">
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

.edge.strong {
  stroke: var(--refino-primary, #18a058);
  stroke-width: 2.2;
}

.node rect {
  fill: var(--refino-node-bg);
  stroke: var(--refino-node-border);
  stroke-width: 1.2;
  cursor: pointer;
}

.node:hover rect,
.node.hovered rect {
  stroke: var(--refino-primary, #18a058);
  stroke-width: 2;
}

.node.selected rect {
  stroke: var(--refino-primary, #18a058);
  stroke-width: 2.4;
  fill: rgba(24, 160, 88, 0.12);
}

.node.focus rect {
  stroke-width: 3.2;
}

.node text {
  font-size: 11px;
  fill: currentColor;
  pointer-events: none;
}
</style>
