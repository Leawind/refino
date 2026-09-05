<script setup lang="ts">
// Command palette (README, "布局"): Ctrl/Cmd+K opens the single entry point
// for node search and every global action. Results combine the paginated
// node search with static actions; arrows move, Enter executes, Esc closes.
import { computed, onBeforeUnmount, onMounted, ref, watch, type Component } from "vue";
import { useI18n } from "vue-i18n";
import { NIcon } from "naive-ui";
import {
  AddOutline,
  MoonOutline,
  SunnyOutline,
  RefreshOutline,
  SearchOutline,
} from "@vicons/ionicons5";
import { clientKey } from "../api";
import { injectRequired } from "../context";
import { storeKey } from "../store";
import { workspaceKey } from "../workspace";
import type { SearchNode } from "../types";

const client = injectRequired(clientKey, "client");
const store = injectRequired(storeKey, "store");
const workspace = injectRequired(workspaceKey, "workspace");
const { t } = useI18n();

const open = ref(false);
const query = ref("");
const active = ref(0);
const nodes = ref<SearchNode[]>([]);
const inputEl = ref<HTMLInputElement | null>(null);

interface ActionItem {
  key: string;
  label: string;
  icon?: Component;
  run(): void;
}

const actions = computed<ActionItem[]>(() => [
  {
    key: "create-constraint",
    label: t("node.createConstraint"),
    icon: AddOutline,
    run: () => store.startCreate("constraint"),
  },
  {
    key: "create-premise",
    label: t("node.createPremise"),
    icon: AddOutline,
    run: () => store.startCreate("premise"),
  },
  {
    key: "theme",
    label: store.state.theme === "dark" ? t("app.themeLight") : t("app.themeDark"),
    icon: store.state.theme === "dark" ? SunnyOutline : MoonOutline,
    run: () => store.setTheme(store.state.theme === "dark" ? "light" : "dark"),
  },
  {
    key: "layout-layered",
    label: t("app.layoutLayered"),
    run: () => workspace.setConfig({ layoutMode: "layered" }),
  },
  {
    key: "layout-force",
    label: t("app.layoutForce"),
    run: () => workspace.setConfig({ layoutMode: "force" }),
  },
  {
    key: "direction-lr",
    label: `${t("app.direction")} →`,
    run: () => workspace.setConfig({ direction: "LR" }),
  },
  {
    key: "direction-tb",
    label: `${t("app.direction")} ↓`,
    run: () => workspace.setConfig({ direction: "TB" }),
  },
  {
    key: "direction-rl",
    label: `${t("app.direction")} ←`,
    run: () => workspace.setConfig({ direction: "RL" }),
  },
  {
    key: "direction-bt",
    label: `${t("app.direction")} ↑`,
    run: () => workspace.setConfig({ direction: "BT" }),
  },
  {
    key: "premises",
    label: `${t("canvas.premises")}: ${workspace.state.config.showPremises ? t("app.themeDark") : t("app.themeLight")}`,
    run: () => workspace.setConfig({ showPremises: !workspace.state.config.showPremises }),
  },
  {
    key: "refresh",
    label: t("app.refresh"),
    icon: RefreshOutline,
    run: () => void workspace.reload(),
  },
]);

const q = computed(() => query.value.trim().toLowerCase());

const filteredActions = computed(() =>
  actions.value.filter((action) => q.value === "" || action.label.toLowerCase().includes(q.value)),
);

interface Item {
  key: string;
  kind: "action" | "node";
  label: string;
  sublabel?: string;
  icon?: Component;
  run(): void;
}

const items = computed<Item[]>(() => [
  ...filteredActions.value.map((action) => ({
    key: `action:${action.key}`,
    kind: "action" as const,
    label: action.label,
    icon: action.icon,
    run: action.run,
  })),
  ...nodes.value.map((node) => ({
    key: `node:${node.id}`,
    kind: "node" as const,
    label: node.summary === "" ? t("node.untitled") : node.summary,
    sublabel: node.id,
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

function show(): void {
  open.value = true;
  query.value = "";
  active.value = 0;
  nodes.value = [];
  searchNodes();
  void Promise.resolve().then(() => inputEl.value?.focus());
}

function close(): void {
  open.value = false;
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (open.value) close();
    else show();
    return;
  }
  if (!open.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    close();
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
    close();
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
      <div v-if="open" class="backdrop" @click.self="close">
        <div class="palette" role="dialog" :aria-label="t('palette.title')">
          <div class="input-row">
            <NIcon :component="SearchOutline" class="search-icon" />
            <input
              ref="inputEl"
              v-model="query"
              class="input"
              :placeholder="t('palette.placeholder')"
              @keydown.stop
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
                close();
                item.run();
              "
            >
              <NIcon v-if="item.icon !== undefined" :component="item.icon" class="icon" />
              <span class="label">{{ item.label }}</span>
              <span v-if="item.sublabel !== undefined" class="sublabel">{{ item.sublabel }}</span>
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

.sublabel {
  font-family: monospace;
  font-size: 10px;
  opacity: 0.55;
}

.kind {
  font-size: 10px;
  opacity: 0.45;
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
