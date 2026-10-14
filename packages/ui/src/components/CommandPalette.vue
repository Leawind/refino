<script setup lang="ts">
// Command palette (DESIGN.md, "布局"): Ctrl/Cmd+K opens the single entry point
// for node search and every global action. Results combine the paginated
// node search with the shared command registry; arrows move, Enter
// executes, Esc closes.
import { computed, onBeforeUnmount, onMounted, ref, watch, type Component } from "vue";
import { useI18n } from "vue-i18n";
import { NIcon } from "naive-ui";
import {
  AddOutline,
  MoonOutline,
  RefreshOutline,
  SearchOutline,
  SunnyOutline,
  HelpCircleOutline,
} from "@vicons/ionicons5";
import { clientKey } from "../api";
import { commands, commandLabel, type Command } from "../commands";
import { injectRequired } from "../context";
import { closePalette, paletteState, togglePalette } from "../palette";
import { storeKey } from "../store";
import { workspaceKey } from "../workspace";
import type { SearchNode } from "../types";

const client = injectRequired(clientKey, "client");
const store = injectRequired(storeKey, "store");
const workspace = injectRequired(workspaceKey, "workspace");
const { t } = useI18n();

const ctx = { store, workspace };

const query = ref("");
const active = ref(0);
const nodes = ref<SearchNode[]>([]);
const inputEl = ref<HTMLInputElement | null>(null);

const ICONS: Record<string, Component> = {
  "create-decision": AddOutline,
  "create-premise": AddOutline,
  theme: store.state.theme === "dark" ? SunnyOutline : MoonOutline,
  "help-shortcuts": HelpCircleOutline,
  refresh: RefreshOutline,
};

function iconOf(command: Command): Component | undefined {
  if (command.id === "theme") return store.state.theme === "dark" ? SunnyOutline : MoonOutline;
  return ICONS[command.id];
}

const actions = computed(() =>
  commands.map((command) => ({
    key: command.id,
    label: commandLabel(command, ctx, t),
    keys: command.keys,
    icon: iconOf(command),
    run: () => command.run(ctx),
  })),
);

const q = computed(() => query.value.trim().toLowerCase());

const filteredActions = computed(() =>
  actions.value.filter((action) => q.value === "" || action.label.toLowerCase().includes(q.value)),
);

interface Item {
  key: string;
  kind: "action" | "node";
  label: string;
  keys?: string;
  icon?: Component;
  run(): void;
}

const items = computed<Item[]>(() => [
  ...filteredActions.value.map((action) => ({
    key: `action:${action.key}`,
    kind: "action" as const,
    label: action.label,
    keys: action.keys,
    icon: action.icon,
    run: action.run,
  })),
  ...nodes.value.map((node) => ({
    key: `node:${node.id}`,
    kind: "node" as const,
    label: node.summary === "" ? t("node.untitled") : node.summary,
    run: () => workspace.select(node),
  })),
]);

let searchToken = 0;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

function searchNodes(): void {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    const token = ++searchToken;
    try {
      const page = await client.search({ q: query.value.trim(), limit: 8 });
      if (token === searchToken) nodes.value = page.nodes;
    } catch {
      // Node search is best-effort inside the palette.
    }
  }, 150);
}

watch(query, searchNodes);

/** Every open — whatever surface asked for it — starts a fresh search. */
watch(
  () => paletteState.open,
  (value) => {
    if (!value) return;
    query.value = "";
    active.value = 0;
    nodes.value = [];
    searchNodes();
    void Promise.resolve().then(() => inputEl.value?.focus());
  },
);

function onKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    togglePalette();
    return;
  }
  if (!paletteState.open) return;
  if (event.key === "Escape") {
    closePalette();
    // The app shell's Esc handler (clear selection) also sits on document:
    // this listener registered first (child before parent), so stop the
    // event here or closing the palette would clear the selection.
    event.stopImmediatePropagation();
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    active.value = Math.min(active.value + 1, items.value.length - 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    active.value = Math.max(active.value - 1, 0);
  } else if (event.key === "Enter") {
    event.preventDefault();
    const item = items.value[active.value];
    if (item === undefined) return;
    closePalette();
    item.run();
  }
}

onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown);
  clearTimeout(debounceTimer);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="palette">
      <div v-if="paletteState.open" class="backdrop" @click.self="closePalette">
        <div class="palette" role="dialog" :aria-label="t('palette.title')">
          <div class="input-row">
            <NIcon :component="SearchOutline" class="search-icon" />
            <input
              ref="inputEl"
              v-model="query"
              class="input"
              :placeholder="t('palette.placeholder')"
            />
          </div>
          <ul class="list">
            <li
              v-for="(item, index) in items"
              :key="item.key"
              class="item"
              :class="{ active: index === active }"
              @mousemove="active = index"
              @click="
                closePalette();
                item.run();
              "
            >
              <NIcon v-if="item.icon !== undefined" :component="item.icon" class="icon" />
              <span class="label">{{ item.label }}</span>
              <kbd v-if="item.keys !== undefined" class="keys">{{ item.keys }}</kbd>
              <span class="kind">{{
                item.kind === "action" ? t("palette.action") : t("palette.node")
              }}</span>
            </li>
            <li v-if="items.length === 0" class="empty">{{ t("palette.noResults") }}</li>
          </ul>
          <div class="hints">
            <span>↑ ↓ {{ t("palette.navigate") }}</span>
            <span>⏎ {{ t("palette.execute") }}</span>
            <span>Esc {{ t("window.close") }}</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 200;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 12vh;
}

.palette {
  width: min(560px, calc(100vw - 32px));
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  background: var(--refino-surface);
  border: 1px solid var(--refino-border);
  border-radius: var(--refino-radius);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
  overflow: hidden;
}

.input-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--refino-border);
}

.search-icon {
  opacity: 0.5;
}

.input {
  flex: 1;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  outline: none;
}

.list {
  flex: 1;
  overflow-y: auto;
  margin: 0;
  padding: 6px;
  list-style: none;
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}

.item.active {
  background: rgba(24, 160, 88, 0.14);
}

.icon {
  opacity: 0.6;
}

.label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kind {
  font-size: 10px;
  opacity: 0.45;
}

.keys {
  flex: none;
  font-family: monospace;
  font-size: 11px;
  padding: 0 6px;
  border: 1px solid var(--refino-border);
  border-radius: 5px;
  opacity: 0.7;
}

.empty {
  padding: 16px;
  text-align: center;
  font-size: 13px;
  opacity: 0.55;
}

.hints {
  display: flex;
  gap: 14px;
  padding: 6px 14px;
  border-top: 1px solid var(--refino-border);
  font-size: 11px;
  opacity: 0.5;
}

.palette-enter-active,
.palette-leave-active {
  transition: opacity 0.12s ease;
}

.palette-enter-from,
.palette-leave-to {
  opacity: 0;
}
</style>
