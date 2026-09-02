<script setup lang="ts">
// Sidebar listing one node type only (constraints on the left, premises on
// the right). Width is a percentage of the whole interface; dragging it
// below the minimum collapses the panel to a floating expand button. The
// panel can dock (push the graph aside) or float over the graph.
import { computed, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import { NButton, NInput, NTag } from "naive-ui";
import { store } from "../store";
import type { NodeType } from "../types";

const props = defineProps<{ type: NodeType; side: "left" | "right" }>();

const { t } = useI18n();

const MIN_PERCENT = 10;
const MAX_PERCENT = 40;

const rootEl = ref<HTMLElement | null>(null);
const widthPercent = ref(20);
const collapsed = ref(false);
const floating = ref(false);
const query = ref("");

const widthStyle = computed(() => ({ width: `${widthPercent.value}%` }));

const panelStyle = computed(() => {
  if (collapsed.value) {
    // No strip: just a floating expand button over the graph.
    return {
      position: "absolute" as const,
      top: "50%",
      transform: "translateY(-50%)",
      [props.side]: "8px",
      zIndex: 10,
    };
  }
  if (floating.value) {
    return {
      position: "absolute" as const,
      top: 0,
      bottom: 0,
      [props.side]: 0,
      zIndex: 15,
      ...widthStyle.value,
    };
  }
  return widthStyle.value;
});

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  const nodes = store.state.nodes.filter((n) => n.type === props.type);
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (q === "") return nodes;
  return nodes.filter((n) => n.id.toLowerCase().includes(q) || n.summary.toLowerCase().includes(q));
});

const placeholder = computed(() =>
  props.type === "constraint" ? t("sidebar.searchConstraints") : t("sidebar.searchPremises"),
);

function toggleCollapsed(): void {
  collapsed.value = !collapsed.value;
}

let startX = 0;
let startPercent = 0;

function onResizeStart(event: MouseEvent): void {
  startX = event.clientX;
  startPercent = widthPercent.value;
  document.addEventListener("mousemove", onResizeMove);
  document.addEventListener("mouseup", onResizeEnd);
}

function onResizeMove(event: MouseEvent): void {
  const delta = event.clientX - startX;
  const signed = props.side === "left" ? delta : -delta;
  const base = rootEl.value?.parentElement?.clientWidth ?? 1;
  const percent = startPercent + (signed / base) * 100;
  if (percent < MIN_PERCENT) {
    // Dragging far enough inward collapses the panel directly.
    collapsed.value = true;
    onResizeEnd();
    return;
  }
  widthPercent.value = Math.min(MAX_PERCENT, percent);
}

function onResizeEnd(): void {
  document.removeEventListener("mousemove", onResizeMove);
  document.removeEventListener("mouseup", onResizeEnd);
}

onBeforeUnmount(() => onResizeEnd());

/** Double click opens the detail window; single click only selects. */
function open(nodeId: string): void {
  store.select(nodeId);
  store.openDetail();
}
</script>

<template>
  <aside ref="rootEl" class="panel" :class="[side, { collapsed, floating }]" :style="panelStyle">
    <template v-if="!collapsed">
      <div class="head">
        <span class="title">{{ t(`sidebar.${type}s`) }}</span>
        <span class="head-actions">
          <NButton
            quaternary
            circle
            size="tiny"
            :title="floating ? t('app.dock') : t('app.float')"
            @click="floating = !floating"
          >
            ⧉
          </NButton>
          <NButton
            quaternary
            circle
            size="tiny"
            :title="t('app.collapse')"
            @click="toggleCollapsed"
          >
            {{ side === "left" ? "«" : "»" }}
          </NButton>
        </span>
      </div>
      <div class="search">
        <NInput v-model:value="query" size="small" clearable :placeholder="placeholder" />
      </div>
      <ul class="list">
        <li
          v-for="node in filtered"
          :key="node.id"
          class="item"
          :class="{ selected: node.id === store.state.selectedId }"
          @click="store.select(node.id)"
          @dblclick="open(node.id)"
        >
          <div class="item-head">
            <span class="id">{{ node.id }}</span>
            <NTag
              size="tiny"
              :bordered="false"
              :type="node.type === 'premise' ? 'default' : 'primary'"
            >
              {{ t(`node.${node.type}`) }}
            </NTag>
          </div>
          <div class="summary">
            {{ node.summary === "" ? t("node.untitled") : node.summary }}
          </div>
        </li>
      </ul>
    </template>
    <template v-else>
      <NButton circle size="small" class="expand" :title="t('app.expand')" @click="toggleCollapsed">
        {{ side === "left" ? "»" : "«" }}
      </NButton>
    </template>
    <div v-if="!collapsed" class="resize-handle" @mousedown.prevent="onResizeStart" />
  </aside>
</template>

<style scoped>
.panel {
  flex: none;
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  border-right: 1px solid var(--refino-border);
  box-sizing: border-box;
}

.panel.right {
  border-right: none;
  border-left: 1px solid var(--refino-border);
}

.panel.floating {
  background: var(--refino-surface);
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.25);
}

.panel.collapsed {
  display: block;
  border: none;
  background: transparent;
}

.expand {
  display: block;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 8px 0;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.title {
  font-size: 12px;
  font-weight: 600;
  opacity: 0.75;
}

.search {
  padding: 8px;
}

.list {
  flex: 1;
  overflow-y: auto;
  margin: 0;
  padding: 0 6px 6px;
  list-style: none;
}

.item {
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
}

.item:hover {
  background: rgba(128, 128, 128, 0.12);
}

.item.selected {
  background: rgba(24, 160, 88, 0.15);
}

.item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.id {
  font-family: monospace;
  font-size: 12px;
  opacity: 0.75;
}

.summary {
  font-size: 13px;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  right: -3px;
  width: 6px;
  cursor: col-resize;
  z-index: 5;
}

.panel.right .resize-handle {
  right: auto;
  left: -3px;
}

.resize-handle:hover {
  background: rgba(24, 160, 88, 0.25);
}
</style>
