<script setup lang="ts">
// The finder panel (ui DESIGN.md, "布局"): one searchable list for every
// node plus the create actions, pinned in the left column. It answers
// "where is it" only — the node itself is read and written in the right
// pane, so rows stay one line and carry no editor. Listings come from the
// paginated /api/search endpoint; the full graph is never loaded.
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { NButton, NIcon, NInput, NSpin } from "naive-ui";
import { AddOutline, ChevronForwardOutline, SearchOutline } from "@vicons/ionicons5";
import { clientKey } from "../api";
import { injectRequired } from "../context";
import { peekHide, peekMove } from "../peek";
import { readNumberPreference, readPreference, writePreference } from "../preferences";
import { storeKey } from "../store";
import { workspaceKey } from "../workspace";
import FinderHead from "./FinderHead.vue";
import type { NodeType, SearchNode } from "../types";

const client = injectRequired(clientKey, "client");
const store = injectRequired(storeKey, "store");
const workspace = injectRequired(workspaceKey, "workspace");
const { t } = useI18n();

const PAGE_SIZE = 50;
const DEBOUNCE_MS = 250;
const WIDTH_KEY = "refino.finder.width";
const COLLAPSED_KEY = "refino.finder.collapsed";
const WIDTH_MIN = 220;
const WIDTH_MAX = 460;

const rootEl = ref<HTMLElement | null>(null);
const collapsed = ref(readPreference<string>(COLLAPSED_KEY, "false") === "true");
const width = ref(clampWidth(readNumberPreference(WIDTH_KEY, 288)));
const searchEl = ref<InstanceType<typeof NInput> | null>(null);

function clampWidth(value: number): number {
  return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, value));
}

const style = computed(() => (collapsed.value ? undefined : { width: `${width.value}px` }));

const query = ref("");

/** "all" lists both types; the unreferenced view implies premises. */
const typeFilter = ref<"all" | NodeType>("all");
const unreferencedOnly = ref(false);

const items = ref<SearchNode[]>([]);
const nextCursor = ref<string | undefined>(undefined);
const loading = ref(false);

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let searchToken = 0;

const effectiveType = computed<"premise" | "decision" | undefined>(() =>
  unreferencedOnly.value ? "premise" : typeFilter.value === "all" ? undefined : typeFilter.value,
);

const scopes = computed(() => [
  { value: "all" as const, label: t("explorer.all") },
  { value: "decision" as const, label: t("node.decisions") },
  { value: "premise" as const, label: t("node.premises") },
]);

async function fetchPage(
  cursor: string | undefined,
  replace: boolean,
): Promise<SearchNode[] | null> {
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
    if (token !== searchToken) return null;
    items.value = replace ? page.nodes : [...items.value, ...page.nodes];
    nextCursor.value = page.nextCursor;
    return page.nodes;
  } catch {
    // The listing is best-effort; keep the previous page on failure.
    return null;
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

function setScope(value: "all" | NodeType): void {
  typeFilter.value = value;
  unreferencedOnly.value = false;
}

/** The quick view fixes the type to premises, so it clears any narrower
 * filter at the same time; otherwise the chips would disagree. */
function toggleUnreferenced(): void {
  unreferencedOnly.value = !unreferencedOnly.value;
  if (unreferencedOnly.value) typeFilter.value = "premise";
}

function select(node: SearchNode): void {
  workspace.select(node);
}

/** Enter in the search box takes the first hit, so a query can be acted on
 * without reaching for the pointer. Search immediately: a fast Enter must
 * not select the previous query's result still shown during the debounce. */
async function onSearchEnter(): Promise<void> {
  clearTimeout(debounceTimer);
  const found = await fetchPage(undefined, true);
  const first = found?.[0];
  if (first !== undefined) select(first);
}

/** Double click opens the editor sheet (ui DESIGN.md, "编辑功能"). The sheet
 * selects the node only once it actually takes over, so clicking while a
 * draft is open does not move the canvas focus for nothing. */
function open(node: SearchNode): void {
  store.openEditor(node.id);
}

function onRowMove(event: MouseEvent, node: SearchNode): void {
  peekMove(node.id, event.clientX, event.clientY);
}

function setCollapsed(value: boolean): void {
  collapsed.value = value;
  writePreference(COLLAPSED_KEY, String(value));
}

/** A collapsed rail can still reach search. */
async function expandAndSearch(): Promise<void> {
  setCollapsed(false);
  await nextTick();
  searchEl.value?.focus();
}

let startX = 0;
let startWidth = 0;

function onResizeStart(event: MouseEvent): void {
  startX = event.clientX;
  startWidth = width.value;
  window.addEventListener("mousemove", onResizeMove);
  window.addEventListener("mouseup", onResizeEnd);
}

function onResizeMove(event: MouseEvent): void {
  width.value = clampWidth(startWidth + (event.clientX - startX));
}

function onResizeEnd(): void {
  writePreference(WIDTH_KEY, String(width.value));
  window.removeEventListener("mousemove", onResizeMove);
  window.removeEventListener("mouseup", onResizeEnd);
}

onBeforeUnmount(() => {
  clearTimeout(debounceTimer);
  onResizeEnd();
});
</script>

<template>
  <aside ref="rootEl" class="finder" :class="{ collapsed }" :style="style">
    <template v-if="!collapsed">
      <FinderHead @collapse="setCollapsed(true)" />

      <div class="search">
        <NInput
          ref="searchEl"
          v-model:value="query"
          size="small"
          clearable
          :placeholder="t('sidebar.search')"
          @keydown.enter="onSearchEnter"
        >
          <template #prefix>
            <NIcon :component="SearchOutline" :size="14" />
          </template>
        </NInput>
        <div class="scopes">
          <button
            v-for="scope in scopes"
            :key="scope.value"
            class="ui-chip"
            :class="{ 'is-on': !unreferencedOnly && typeFilter === scope.value }"
            @click="setScope(scope.value)"
          >
            {{ scope.label }}
          </button>
          <button
            class="ui-chip"
            :class="{ 'is-on': unreferencedOnly }"
            :title="t('explorer.unreferenced')"
            @click="toggleUnreferenced"
          >
            {{ t("explorer.unreferenced") }}
          </button>
        </div>
      </div>

      <ul class="list" @scroll="onScroll">
        <li
          v-for="nodeItem in items"
          :key="nodeItem.id"
          class="item"
          :class="{
            selected: workspace.state.selection.includes(nodeItem.id),
            focused: workspace.state.focusId === nodeItem.id,
          }"
          @click="select(nodeItem)"
          @dblclick="open(nodeItem)"
          @mousemove="onRowMove($event, nodeItem)"
          @mouseleave="peekHide(nodeItem.id)"
        >
          <span
            class="glyph"
            :class="nodeItem.type"
            :title="t(nodeItem.type === 'decision' ? 'node.decision' : 'node.premise')"
          />
          <span class="summary" :title="nodeItem.summary">
            {{ nodeItem.summary === "" ? t("node.untitled") : nodeItem.summary }}
          </span>
          <span v-if="store.isDirty(nodeItem.id)" class="dirty" :title="t('inline.dirty')" />
        </li>
        <li v-if="items.length === 0 && !loading" class="no-results">
          {{ t("explorer.noResults") }}
        </li>
        <li v-if="loading" class="more">
          <NSpin size="small" />
        </li>
      </ul>

      <footer class="create">
        <button class="create-btn" @click="store.startCreate('decision')">
          <NIcon :component="AddOutline" :size="14" />
          {{ t("node.decision") }}
        </button>
        <button class="create-btn" @click="store.startCreate('premise')">
          <NIcon :component="AddOutline" :size="14" />
          {{ t("node.premise") }}
        </button>
      </footer>

      <div class="resize" @mousedown.prevent="onResizeStart" />
    </template>

    <div v-else class="rail">
      <button class="ui-icon-btn" :title="t('app.expand')" @click="setCollapsed(false)">
        <NIcon :component="ChevronForwardOutline" />
      </button>
      <button class="ui-icon-btn" :title="t('sidebar.search')" @click="expandAndSearch">
        <NIcon :component="SearchOutline" />
      </button>
      <span class="rail-spacer" />
      <button
        class="ui-icon-btn"
        :title="t('node.createDecision')"
        @click="store.startCreate('decision')"
      >
        <NIcon :component="AddOutline" />
      </button>
    </div>
  </aside>
</template>

<style scoped>
.finder {
  flex: none;
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: var(--refino-surface);
  border-right: 1px solid var(--refino-border);
  box-sizing: border-box;
}

.finder.collapsed {
  width: 44px;
}

.search {
  flex: none;
  padding: 10px 10px 8px;
}

.scopes {
  display: flex;
  gap: 4px;
  margin-top: 8px;
  overflow-x: auto;
  scrollbar-width: none;
}

.scopes::-webkit-scrollbar {
  display: none;
}

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: 2px 6px 10px;
  list-style: none;
  user-select: none;
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  padding: 4px 8px;
  border-radius: var(--refino-radius-sm);
  cursor: pointer;
}

.item:hover {
  background: var(--refino-surface-raised);
}

.item.selected {
  background: var(--refino-accent-soft);
}

/* The focus is the last selection entry; an inset accent marks it without
 * shifting the row's text when the focus moves. */
.item.focused {
  box-shadow: inset 2px 0 0 var(--refino-primary);
}

.glyph {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--refino-text-faint);
}

.glyph.decision {
  border-radius: 1px;
  transform: rotate(45deg);
  background: var(--refino-primary);
}

.item.selected .glyph {
  background: var(--refino-primary);
}

.summary {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dirty {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--refino-warn);
}

.no-results {
  padding: 18px 8px;
  font-size: 12px;
  color: var(--refino-text-faint);
  text-align: center;
}

.more {
  display: grid;
  place-items: center;
  padding: 8px;
}

/* Creation is authoring's primary verb: pinned at the panel's foot. */
.create {
  flex: none;
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid var(--refino-border);
}

.create-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 30px;
  border: 1px dashed var(--refino-border-strong);
  border-radius: var(--refino-radius-sm);
  background: transparent;
  color: var(--refino-text-dim);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.create-btn:hover {
  border-color: var(--refino-primary);
  border-style: solid;
  color: var(--refino-primary);
  background: var(--refino-accent-soft);
}

.resize {
  position: absolute;
  top: 0;
  bottom: 0;
  right: -3px;
  width: 6px;
  cursor: col-resize;
  z-index: 5;
}

.resize:hover {
  background: var(--refino-accent-soft);
}

/* The collapsed rail keeps search and creation one click away. */
.rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  height: 100%;
  padding: 8px 0;
}

.rail-spacer {
  flex: 1;
}
</style>
