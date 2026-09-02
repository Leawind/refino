<script setup lang="ts">
// Sidebar listing one node type only (constraints on the left, premises on
// the right). Resizable by dragging its inner edge; collapsible to a narrow
// strip.
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { NButton, NInput, NTag } from "naive-ui";
import { store } from "../store";
import type { NodeType } from "../types";

const props = defineProps<{ type: NodeType; side: "left" | "right" }>();

const { t } = useI18n();

const MIN_WIDTH = 180;
const MAX_WIDTH = 520;
const COLLAPSED_WIDTH = 20;

const width = ref(280);
const collapsed = ref(false);
const query = ref("");

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
let startWidth = 0;

function onResizeStart(event: MouseEvent): void {
  startX = event.clientX;
  startWidth = width.value;
  document.addEventListener("mousemove", onResizeMove);
  document.addEventListener("mouseup", onResizeEnd);
}

function onResizeMove(event: MouseEvent): void {
  const delta = event.clientX - startX;
  const signed = props.side === "left" ? delta : -delta;
  width.value = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + signed));
}

function onResizeEnd(): void {
  document.removeEventListener("mousemove", onResizeMove);
  document.removeEventListener("mouseup", onResizeEnd);
}
</script>

<template>
  <aside
    class="panel"
    :class="[side, { collapsed }]"
    :style="{ width: collapsed ? COLLAPSED_WIDTH + 'px' : width + 'px' }"
  >
    <template v-if="!collapsed">
      <div class="head">
        <span class="title">{{ t(`sidebar.${type}s`) }}</span>
        <NButton quaternary circle size="tiny" :title="t('app.collapse')" @click="toggleCollapsed">
          {{ side === "left" ? "«" : "»" }}
        </NButton>
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
      <NButton
        quaternary
        circle
        size="tiny"
        class="expand"
        :title="t('app.expand')"
        @click="toggleCollapsed"
      >
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
  border-right: 1px solid var(--refino-border);
  box-sizing: border-box;
}

.panel.right {
  border-right: none;
  border-left: 1px solid var(--refino-border);
}

.panel.collapsed {
  align-items: center;
  padding-top: 8px;
}

.expand {
  align-self: center;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 8px 0;
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
