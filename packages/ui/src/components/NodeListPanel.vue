<script setup lang="ts">
// Sidebar listing one node type only (constraints on the left, premises on
// the right). Width is a percentage of the whole interface; dragging it
// below the minimum collapses it to a floating round button, and dragging
// back during the same gesture restores it. The panel can dock (push the
// graph aside) or float over the graph.
import { computed, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import { NButton, NIcon, NInput } from "naive-ui";
import {
  AddOutline,
  ChevronBackOutline,
  ChevronForwardOutline,
  OpenOutline,
  ScanOutline,
} from "@vicons/ionicons5";
import { store } from "../store";
import type { NodeType } from "../types";

const props = defineProps<{ type: NodeType; side: "left" | "right" }>();

const { t } = useI18n();

const MIN_PERCENT = 4;
const MAX_PERCENT = 40;

const rootEl = ref<HTMLElement | null>(null);
const widthPercent = ref(20);
const collapsed = ref(false);
const floating = ref(false);
const query = ref("");

const widthStyle = computed(() => ({ width: `${widthPercent.value}%` }));

const panelStyle = computed(() => {
  if (collapsed.value) {
    // No strip: a single round expand button at the same height as the
    // in-panel collapse button, floating over the graph.
    return {
      position: "absolute" as const,
      top: "10px",
      [props.side]: "8px",
      zIndex: 10,
    };
  }
  if (floating.value) {
    return {
      position: "absolute" as const,
      top: "8px",
      bottom: "8px",
      [props.side]: "8px",
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
  // Reaching the minimum just stops shrinking; collapsing is a separate,
  // explicit action on the panel header.
  widthPercent.value = Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, percent));
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
        <NButton
          circle
          size="tiny"
          class="head-btn collapse"
          :title="t('app.collapse')"
          @click="toggleCollapsed"
        >
          <NIcon :component="side === 'left' ? ChevronBackOutline : ChevronForwardOutline" />
        </NButton>
        <span class="head-actions">
          <NButton
            circle
            size="tiny"
            class="head-btn"
            :title="floating ? t('app.dock') : t('app.float')"
            @click="floating = !floating"
          >
            <NIcon :component="floating ? ScanOutline : OpenOutline" />
          </NButton>
        </span>
      </div>
      <div class="search">
        <NInput v-model:value="query" size="small" clearable :placeholder="placeholder" />
      </div>
      <ul class="list">
        <li class="create-item">
          <NButton dashed size="small" class="create" @click="store.startCreate(type)">
            <NIcon :component="AddOutline" />
            {{ type === "constraint" ? t("node.createConstraint") : t("node.createPremise") }}
          </NButton>
        </li>
        <li
          v-for="node in filtered"
          :key="node.id"
          class="item"
          :class="{ selected: node.id === store.state.selectedId }"
          @click="store.select(node.id)"
          @dblclick="open(node.id)"
        >
          <div class="summary">
            {{ node.summary === "" ? t("node.untitled") : node.summary }}
          </div>
          <div class="id">{{ node.id }}</div>
        </li>
      </ul>
    </template>
    <template v-else>
      <NButton circle size="small" class="expand" :title="t('app.expand')" @click="toggleCollapsed">
        <NIcon :component="side === 'left' ? ChevronForwardOutline : ChevronBackOutline" />
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
  border-radius: var(--refino-radius);
  border: 1px solid var(--refino-border);
}

.panel.collapsed {
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
}

/* Same size and height as the in-panel collapse button, but opaque. */
.expand {
  background: var(--refino-surface) !important;
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.2);
}

.head {
  position: relative;
  display: flex;
  align-items: center;
  /* Float toggle sits on the inner side of each panel. */
  justify-content: flex-end;
  padding: 8px 8px 0;
}

.panel.right .head {
  justify-content: flex-start;
}

.head-btn {
  background: var(--refino-surface) !important;
}

/* Collapse lives on the screen-edge side of the panel. */
.collapse {
  position: absolute;
}

.panel.left .collapse {
  left: 8px;
}

.panel.right .collapse {
  right: 8px;
}

.title {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 2px;
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
  user-select: none;
}

.create-item {
  margin: 0 2px 6px;
  list-style: none;
}

.create {
  width: 100%;
}

.item {
  padding: 6px 8px;
  border-radius: var(--refino-radius);
  cursor: pointer;
}

.item:hover {
  background: rgba(128, 128, 128, 0.12);
}

.item.selected {
  background: rgba(24, 160, 88, 0.15);
}

.summary {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Ids are rarely used directly; keep them small, below the summary. */
.id {
  font-family: monospace;
  font-size: 10px;
  opacity: 0.55;
  margin-top: 2px;
  text-align: right;
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
