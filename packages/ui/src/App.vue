<script setup lang="ts">
// Application shell: header, dual sidebars, canvas with floating layers,
// detail bar. Graph data flows through the on-demand workspace; the shell
// only wires lifecycle, global actions and status display.
import { computed, inject, onBeforeUnmount, onMounted, ref, watchEffect } from "vue";
import { useI18n } from "vue-i18n";
import {
  NAlert,
  NButton,
  NConfigProvider,
  NGlobalStyle,
  NLayoutHeader,
  NMessageProvider,
  NPopselect,
  darkTheme,
  zhCN,
  dateZhCN,
  enUS,
  dateEnUS,
} from "naive-ui";
import { injectRequired } from "./context";
import { installAltTracking } from "./peek";
import { storeKey } from "./store";
import { workspaceKey } from "./workspace";

const store = injectRequired(storeKey, "store");
const workspace = injectRequired(workspaceKey, "workspace");
import AppHeader from "./components/AppHeader.vue";
import ResourceExplorer from "./components/ResourceExplorer.vue";
import DecisionGraph from "./components/DecisionGraph.vue";
import NodeDetailWindow from "./components/NodeDetailWindow.vue";
import NodePeek from "./components/NodePeek.vue";
import GraphFloat from "./components/GraphFloat.vue";
import SelectionList from "./components/SelectionList.vue";
import WorkspaceToasts from "./components/WorkspaceToasts.vue";
import type { LayoutDirection } from "./types";
import type { LayoutMode } from "./graph/layout/types";

const { t, locale } = useI18n();

// The store owns the persisted language preference; keep vue-i18n in sync.
watchEffect(() => {
  locale.value = store.state.locale;
});

const constraintCount = computed(
  () => workspace.displayed.value.filter((n) => n.type === "constraint").length,
);

const renderCulled = ref(false);

const naiveTheme = computed(() => (store.state.theme === "dark" ? darkTheme : null));
const naiveLocale = computed(() => (locale.value === "zh" ? zhCN : enUS));
const naiveDateLocale = computed(() => (locale.value === "zh" ? dateZhCN : dateEnUS));

// The display direction is a canvas config value, persisted like the rest
// of the config; the writable computed keeps the v-model wiring local.
const direction = computed<LayoutDirection>({
  get: () => workspace.state.config.direction,
  set: (value) => workspace.setConfig({ direction: value }),
});

const directionOptions = [
  { label: "→", value: "LR" },
  { label: "↓", value: "TB" },
  { label: "←", value: "RL" },
  { label: "↑", value: "BT" },
];

// Layout selection and display direction live in the persisted canvas
// config; the direction switch only applies to layouts with a direction
// (force ignores it).
const layoutMode = computed(() => workspace.state.config.layoutMode);
const layoutOptions = computed(() => [
  { label: t("app.layoutLayered"), value: "layered" },
  { label: t("app.layoutForce"), value: "force" },
]);

function setLayoutMode(mode: LayoutMode): void {
  workspace.setConfig({ layoutMode: mode });
}

// Expose the theme on <html> so token definitions and naive portals
// (which render outside .shell) follow the dark/light switch.
watchEffect(() => {
  document.documentElement.dataset.theme = store.state.theme;
});

onMounted(() => {
  workspace.start();
  // Alt-peek modifier tracking (README, "交互"); cleaned up on unmount.
  onBeforeUnmount(installAltTracking());
});
onBeforeUnmount(() => {
  workspace.stop();
});

function refresh(): void {
  void workspace.reload();
}

// Esc clears the selection; the detail window consumes Esc first when open
// (closing it keeps the selection, per design).
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && !store.state.detailOpen) workspace.clearSelection();
}
onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <NConfigProvider
    :theme="naiveTheme"
    :locale="naiveLocale"
    :date-locale="naiveDateLocale"
    :theme-overrides="{ common: { primaryColor: '#18a058', borderRadius: '8px' } }"
  >
    <NMessageProvider>
      <WorkspaceToasts />
      <NGlobalStyle />
      <!-- Own flex shell: naive's NLayout boxes carry no layout of their own. -->
      <div class="shell" :class="{ dark: store.state.theme === 'dark' }">
        <NLayoutHeader class="header" bordered>
          <AppHeader v-model:direction="direction" @refresh="refresh" />
        </NLayoutHeader>
        <div class="content">
          <NAlert
            v-if="workspace.state.error !== null"
            class="load-error"
            type="error"
            :show-icon="true"
            closable
            @close="workspace.dismissError"
          >
            {{ t("app.loadError") }}: {{ workspace.state.error }}
          </NAlert>
          <div class="workbench">
            <ResourceExplorer />
            <div class="center-pane">
              <div class="graph-area">
                <DecisionGraph
                  :direction="direction"
                  :layout-mode="workspace.state.config.layoutMode"
                  @render-culled="renderCulled = $event"
                />
                <GraphFloat placement="top-right">
                  <SelectionList />
                </GraphFloat>
                <GraphFloat placement="bottom-right">
                  <div class="layout-controls">
                    <NPopselect
                      :value="layoutMode"
                      :options="layoutOptions"
                      trigger="click"
                      @update:value="setLayoutMode"
                    >
                      <NButton circle :title="t('app.layout')">
                        <span v-if="layoutMode === 'layered'">≡</span>
                        <span v-else>⚛</span>
                      </NButton>
                    </NPopselect>
                    <NPopselect
                      v-model:value="direction"
                      :options="directionOptions"
                      trigger="click"
                      :disabled="layoutMode === 'force'"
                    >
                      <NButton
                        circle
                        :disabled="layoutMode === 'force'"
                        :title="t('app.direction')"
                      >
                        {{ direction }}
                      </NButton>
                    </NPopselect>
                  </div>
                </GraphFloat>
                <GraphFloat placement="bottom-left">
                  <div class="status-pill">
                    <span>{{ t("status.constraints") }}: {{ constraintCount }}</span>
                    <span v-if="workspace.state.truncated" class="issues">
                      {{ t("canvas.truncated") }}
                    </span>
                    <span v-if="renderCulled" class="issues">
                      {{ t("canvas.renderCulled") }}
                    </span>
                    <span v-if="workspace.state.issues.length > 0" class="issues">
                      {{ t("status.issues") }}: {{ workspace.state.issues.length }}
                    </span>
                    <span v-if="workspace.state.focusId !== null" class="mono">
                      {{ t("status.selected") }}: {{ workspace.state.focusId }}
                    </span>
                    <span class="hint">{{ t("app.peekHint") }}</span>
                  </div>
                </GraphFloat>
                <NodePeek />
              </div>
              <NodeDetailWindow />
            </div>
          </div>
        </div>
      </div>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style scoped>
.shell {
  /* Fill the host element, whatever size the embedding page gives it. */
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  /* Panes stay transparent: NGlobalStyle colors the body per theme, and
   * header/footer carry naive's own themed background. */
}

.header {
  flex: none;
  height: 48px;
}

.content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.load-error {
  margin: 12px 12px 0;
}

.workbench {
  display: flex;
  flex: 1;
  min-height: 0;
  position: relative;
}

.center-pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.graph-area {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.layout-controls {
  display: flex;
  gap: 8px;
}

.status-pill {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 12px;
  font-size: 12px;
  border-radius: var(--refino-radius);
  background: var(--refino-surface);
  border: 1px solid var(--refino-border);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
  opacity: 0.92;
}

.status-pill .issues {
  color: #d03050;
}

.status-pill .mono {
  font-family: monospace;
}
</style>
