<script setup lang="ts">
// Application shell: header, dual sidebars, canvas with floating layers,
// detail bar. Graph data flows through the on-demand workspace; the shell
// only wires lifecycle, global actions and status display.
import { computed, onBeforeUnmount, onMounted, ref, watchEffect } from "vue";
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
import { store } from "./store";
import { workspace } from "./workspace";
import { i18n } from "./i18n";
import AppHeader from "./components/AppHeader.vue";
import NodeListPanel from "./components/NodeListPanel.vue";
import DecisionGraph from "./components/DecisionGraph.vue";
import NodeDetailWindow from "./components/NodeDetailWindow.vue";
import GraphFloat from "./components/GraphFloat.vue";
import SelectionList from "./components/SelectionList.vue";
import WorkspaceToasts from "./components/WorkspaceToasts.vue";
import type { LayoutDirection } from "./types";

const { t } = useI18n();

const constraintCount = computed(
  () => workspace.displayed.value.filter((n) => n.type === "constraint").length,
);
const premiseCount = computed(
  () => workspace.displayed.value.filter((n) => n.type === "premise").length,
);

const naiveTheme = computed(() => (store.state.theme === "dark" ? darkTheme : null));
const naiveLocale = computed(() => (i18n.global.locale.value === "zh" ? zhCN : enUS));
const naiveDateLocale = computed(() => (i18n.global.locale.value === "zh" ? dateZhCN : dateEnUS));

const direction = ref<LayoutDirection>("LR");

const directionOptions = [
  { label: "→", value: "LR" },
  { label: "↓", value: "TB" },
  { label: "←", value: "RL" },
  { label: "↑", value: "BT" },
];

// Expose the theme on <html> so token definitions and naive portals
// (which render outside .shell) follow the dark/light switch.
watchEffect(() => {
  document.documentElement.dataset.theme = store.state.theme;
});

onMounted(() => {
  workspace.start();
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
            <NodeListPanel type="constraint" side="left" />
            <div class="center-pane">
              <div class="graph-area">
                <DecisionGraph :direction="direction" />
                <GraphFloat placement="top-right">
                  <SelectionList />
                </GraphFloat>
                <GraphFloat placement="bottom-right">
                  <NPopselect v-model:value="direction" :options="directionOptions" trigger="click">
                    <NButton circle :title="t('app.direction')">{{ direction }}</NButton>
                  </NPopselect>
                </GraphFloat>
                <GraphFloat placement="bottom-left">
                  <div class="status-pill">
                    <span>{{ t("status.constraints") }}: {{ constraintCount }}</span>
                    <span>{{ t("status.premises") }}: {{ premiseCount }}</span>
                    <span v-if="workspace.state.truncated" class="issues">
                      {{ t("canvas.truncated") }}
                    </span>
                    <span v-if="workspace.state.issues.length > 0" class="issues">
                      {{ t("status.issues") }}: {{ workspace.state.issues.length }}
                    </span>
                    <span v-if="workspace.state.focusId !== null" class="mono">
                      {{ t("status.selected") }}: {{ workspace.state.focusId }}
                    </span>
                  </div>
                </GraphFloat>
              </div>
              <NodeDetailWindow />
            </div>
            <NodeListPanel type="premise" side="right" />
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
