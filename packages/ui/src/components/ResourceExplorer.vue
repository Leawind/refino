<script setup lang="ts">
// The single resource explorer (README, "布局"): one list for constraints
// and premises with a type filter and the unreferenced-premises quick view.
// Listings come from the paginated /api/search endpoint — the full graph is
// never loaded. Rows expand into the inline editor (single accordion);
// expansion never touches the panel width. Alt+hover peeks a node. Width is
// a percentage of the whole interface; dragging below the minimum collapses
// it to a floating round button, and the panel can dock or float.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { NButton, NIcon, NInput, NPopselect, NSpin } from "naive-ui";
import {
  AddOutline,
  ChevronBackOutline,
  ChevronForwardOutline,
  OpenOutline,
  ScanOutline,
} from "@vicons/ionicons5";
import { clientKey, type RefinoClient } from "../api";
import { injectRequired } from "../context";
import { peekHide, peekMove } from "../peek";
import { storeKey } from "../store";
import { workspaceKey } from "../workspace";
import InlineNodeForm from "./InlineNodeForm.vue";
import type { NodeType, SearchNode } from "../types";

const client = injectRequired(clientKey, "client");
const store = injectRequired(storeKey, "store");
const workspace = injectRequired(workspaceKey, "workspace");
const { t } = useI18n();

const MIN_PERCENT = 4;
const MAX_PERCENT = 40;
const PAGE_SIZE = 50;
const DEBOUNCE_MS = 250;

const SIDE = "left";

const rootEl = ref<HTMLElement | null>(null);
const widthPercent = ref(20);
const collapsed = ref(false);
const floating = ref(false);
const query = ref("");

/** "all" lists both types; the unreferenced view implies premises. */
const typeFilter = ref<"all" | NodeType>("all");
const unreferencedOnly = ref(false);
const filterOptions = computed(() => [
  { label: t("explorer.all"), value: "all" },
  { label: t("node.constraints"), value: "constraint" },
  { label: t("node.premises"), value: "premise" },
]);
const typeLabel = computed(
  () =>
    filterOptions.value.find((option) => option.value === typeFilter.value)?.label ??
    t("explorer.all"),
);

const widthStyle = computed(() => ({ width: `${widthPercent.value}%` }));

const panelStyle = computed(() => {
  if (collapsed.value) {
    return {
      position: "absolute" as const,
      top: "8px",
      [`${SIDE}`]: "8px",
      zIndex: 10,
    };
  }
  if (floating.value) {
    return {
      position: "absolute" as const,
      top: "8px",
      bottom: "8px",
      [`${SIDE}`]: "8px",
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

const effectiveType = computed<"premise" | "constraint" | undefined>(() =>
  unreferencedOnly.value ? "premise" : typeFilter.value === "all" ? undefined : typeFilter.value,
);

async function fetchPage(cursor: string | undefined, replace: boolean): Promise<void> {
  const token = ++searchToken;
  loading.value = true;
  try {
    const page = await client.search({
      q: query.value.trim(),
      type: effectiveType.value,
      unreferenced: unreferencedOnly.value || undefined,
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
  void client
    .search({
      q: query.value.trim(),
      type: effectiveType.value,
      unreferenced: unreferencedOnly.value || undefined,
      limit: Math.min(Math.max(items.value.length, PAGE_SIZE), 500),
    })
    .then((page) => {
      if (token !== searchToken) return; // a newer search superseded this one
      items.value = page.nodes;
      nextCursor.value = page.nextCursor;
    });
}

watch([query, typeFilter, unreferencedOnly], () => {
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
  const base = rootEl.value?.parentElement?.clientWidth ?? 1;
  const percent = startPercent + (delta / base) * 100;
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

function select(node: SearchNode): void {
  workspace.select(node);
}

/** Double click opens the modal editor (README, "细节三层模型"). */
function open(node: SearchNode): void {
  select(node);
  store.openDetail(node.id);
}

/** Expand the row into the inline editor; expanding selects the node. */
function toggleExpand(node: SearchNode): void {
  if (store.state.inlineId === node.id) store.collapseInline();
  else {
    select(node);
    store.expandInline(node.id);
  }
}

function onRowMove(event: MouseEvent, node: SearchNode): void {
  peekMove(node.id, event.clientX, event.clientY);
}

function onRowLeave(node: SearchNode): void {
  peekHide(node.id);
}

/** The edit session belongs to this row (expanded, or a kept draft). */
function sessionBelongsTo(node: SearchNode): boolean {
  return store.state.detail.id === node.id;
}

function isDirty(node: SearchNode): boolean {
  return sessionBelongsTo(node) && store.isDirty(node.id);
}
</script>

<template>
  <aside ref="rootEl" class="panel" :class="[SIDE, { collapsed, floating }]" :style="panelStyle">
    <template v-if="!collapsed">
      <div class="head">
        <span class="title">{{ t("explorer.title") }}</span>
        <NButton
          circle
          size="tiny"
          class="head-btn collapse"
          :title="t('app.collapse')"
          @click="toggleCollapsed"
        >
          <NIcon :component="ChevronBackOutline" />
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
        <div class="filters">
          <NPopselect
            :value="typeFilter"
            :options="filterOptions"
            trigger="click"
            @update:value="
              (value: 'all' | NodeType) => ((typeFilter = value), (unreferencedOnly = false))
            "
          >
            <NButton size="tiny" quaternary>{{ typeLabel }}</NButton>
          </NPopselect>
          <NButton
            size="tiny"
            :quaternary="!unreferencedOnly"
            :type="unreferencedOnly ? 'primary' : 'default'"
            :secondary="unreferencedOnly"
            @click="unreferencedOnly = !unreferencedOnly"
          >
            {{ t("explorer.unreferenced") }}
          </NButton>
        </div>
      </div>
      <ul class="list" @scroll="onScroll">
        <li class="create-item">
          <div class="create-row">
            <NButton
              dashed
              size="small"
              class="create"
              :title="t('node.createConstraint')"
              @click="store.startCreate('constraint')"
            >
              <NIcon :component="AddOutline" />
              {{ t("node.constraint") }}
            </NButton>
            <NButton
              dashed
              size="small"
              class="create"
              :title="t('node.createPremise')"
              @click="store.startCreate('premise')"
            >
              <NIcon :component="AddOutline" />
              {{ t("node.premise") }}
            </NButton>
          </div>
        </li>
        <li
          v-for="nodeItem in items"
          :key="nodeItem.id"
          class="item"
          :class="{
            selected: workspace.state.selection.includes(nodeItem.id),
            expanded: store.state.inlineId === nodeItem.id,
          }"
          @click="select(nodeItem)"
          @dblclick="open(nodeItem)"
          @mousemove="onRowMove($event, nodeItem)"
          @mouseleave="onRowLeave(nodeItem)"
        >
          <div class="row">
            <button
              class="chevron"
              :class="{ open: store.state.inlineId === nodeItem.id }"
              :title="t('inline.toggle')"
              @click.stop="toggleExpand(nodeItem)"
            >
              ▸
            </button>
            <div class="texts">
              <div class="summary">
                {{ nodeItem.summary === "" ? t("node.untitled") : nodeItem.summary }}
                <span v-if="isDirty(nodeItem)" class="dirty" :title="t('inline.dirty')">◐</span>
              </div>
              <div class="id">{{ nodeItem.id }}</div>
            </div>
          </div>
          <InlineNodeForm :node-id="nodeItem.id" />
        </li>
        <li v-if="loading" class="more">
          <NSpin size="small" />
        </li>
      </ul>
    </template>
    <template v-else>
      <NButton circle size="small" class="expand" :title="t('app.expand')" @click="toggleCollapsed">
        <NIcon :component="ChevronForwardOutline" />
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
  justify-content: flex-end;
  padding: 8px 8px 0;
}

.head-btn {
  background: var(--refino-surface) !important;
}

.collapse {
  position: absolute;
  left: 8px;
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
  padding: 8px 8px 4px;
}

.filters {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
}

.list {
  flex: 1;
  overflow-y: auto;
  margin: 0;
  padding: 4px 6px 6px;
  list-style: none;
  user-select: none;
}

.create-item {
  margin: 0 2px 6px;
  list-style: none;
}

.create-row {
  display: flex;
  gap: 6px;
}

.create {
  flex: 1;
}

.item {
  padding: 0;
  border-radius: var(--refino-radius);
  cursor: pointer;
}

.row {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  padding: 6px 8px;
}

.item:hover .row {
  background: rgba(128, 128, 128, 0.12);
}

.item.selected .row {
  background: rgba(24, 160, 88, 0.15);
}

.chevron {
  flex: none;
  width: 16px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 11px;
  line-height: 20px;
  padding: 0;
  opacity: 0.55;
}

.chevron:hover {
  opacity: 1;
}

.chevron.open {
  transform: rotate(90deg);
}

.texts {
  flex: 1;
  min-width: 0;
}

.summary {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dirty {
  color: #f0a020;
  margin-left: 4px;
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

.resize-handle:hover {
  background: rgba(24, 160, 88, 0.25);
}
</style>
