<script setup lang="ts">
// Sidebar listing one node type only (constraints on the left, premises on
// the right). Listings come from the paginated /api/search endpoint — the
// full graph is never loaded (README, "画布按需查询"). Width is a percentage
// of the whole interface; dragging it below the minimum collapses it to a
// floating round button, and dragging back during the same gesture restores
// it. The panel can dock (push the canvas aside) or float over the canvas.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { NButton, NIcon, NInput, NSpin } from "naive-ui";
import {
  AddOutline,
  ChevronBackOutline,
  ChevronForwardOutline,
  OpenOutline,
  ScanOutline,
} from "@vicons/ionicons5";
import { search } from "../api";
import { store } from "../store";
import { workspace } from "../workspace";
import type { NodeType, SearchNode } from "../types";

const props = defineProps<{ type: NodeType; side: "left" | "right" }>();

const { t } = useI18n();

const MIN_PERCENT = 4;
const MAX_PERCENT = 40;
const PAGE_SIZE = 50;
const DEBOUNCE_MS = 250;

const rootEl = ref<HTMLElement | null>(null);
const widthPercent = ref(20);
const collapsed = ref(false);
const floating = ref(false);
const query = ref("");

const widthStyle = computed(() => ({ width: `${widthPercent.value}%` }));

const panelStyle = computed(() => {
  if (collapsed.value) {
    // No strip: a single round expand button at the same height as the
    // in-panel collapse button, floating over the canvas.
    return {
      position: "absolute" as const,
      top: "8px",
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

const items = ref<SearchNode[]>([]);
const nextCursor = ref<string | undefined>(undefined);
const loading = ref(false);

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let searchToken = 0;

async function fetchPage(cursor: string | undefined, replace: boolean): Promise<void> {
  const token = ++searchToken;
  loading.value = true;
  try {
    const page = await search({
      q: query.value.trim(),
      type: props.type,
      limit: PAGE_SIZE,
      cursor,
    });
    if (token !== searchToken) return;
    items.value = replace ? page.nodes : [...items.value, ...page.nodes];
    nextCursor.value = page.nextCursor;
  } catch {
    // Sidebar listings are best-effort; keep the previous page on failure.
  } finally {
    if (token === searchToken) loading.value = false;
  }
}

/** Re-fetch the already-shown window when the graph changes externally. */
function refreshLoaded(): void {
  if (items.value.length === 0) return;
  const token = searchToken;
  void search({
    q: query.value.trim(),
    type: props.type,
    limit: Math.min(Math.max(items.value.length, PAGE_SIZE), 500),
  }).then((page) => {
    if (token !== searchToken) return; // a newer search superseded this one
    items.value = page.nodes;
    nextCursor.value = page.nextCursor;
  });
}

watch(query, () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void fetchPage(undefined, true), DEBOUNCE_MS);
});

watch(
  () => workspace.state.revision,
  () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refreshLoaded, DEBOUNCE_MS);
  },
);

void fetchPage(undefined, true);

function onScroll(event: Event): void {
  const el = event.target as HTMLElement;
  if (nextCursor.value === undefined || loading.value) return;
  if (el.scrollTop + el.clientHeight < el.scrollHeight - 40) return;
  void fetchPage(nextCursor.value, false);
}

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

onBeforeUnmount(() => {
  clearTimeout(debounceTimer);
  onResizeEnd();
});

/** Double click opens the detail window; single click only selects. */
function open(node: SearchNode): void {
  workspace.select(node);
  store.openDetail();
}

function select(node: SearchNode): void {
  workspace.select(node);
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
        <NInput v-model:value="query" size="small" clearable :placeholder="t('sidebar.search')" />
      </div>
      <ul class="list" @scroll="onScroll">
        <li class="create-item">
          <NButton
            dashed
            size="small"
            class="create"
            :title="type === 'constraint' ? t('node.createConstraint') : t('node.createPremise')"
            @click="store.startCreate(type)"
          >
            <NIcon :component="AddOutline" />
          </NButton>
        </li>
        <li
          v-for="node in items"
          :key="node.id"
          class="item"
          :class="{ selected: workspace.state.selection.includes(node.id) }"
          @click="select(node)"
          @dblclick="open(node)"
        >
          <div class="summary">
            {{ node.summary === "" ? t("node.untitled") : node.summary }}
          </div>
          <div class="id">{{ node.id }}</div>
        </li>
        <li v-if="loading" class="more">
          <NSpin size="small" />
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

.expand {
  background: var(--refino-surface) !important;
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

.more {
  display: grid;
  place-items: center;
  padding: 8px;
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
