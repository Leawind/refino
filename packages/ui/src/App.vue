<script setup lang="ts">
// Application shell: header, dual sidebars, decision graph with floating
// layers, floating detail window.
import { computed, onMounted, ref } from "vue";
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
import { i18n } from "./i18n";
import AppHeader from "./components/AppHeader.vue";
import NodeListPanel from "./components/NodeListPanel.vue";
import DecisionGraph from "./components/DecisionGraph.vue";
import NodeDetailWindow from "./components/NodeDetailWindow.vue";
import GraphFloat from "./components/GraphFloat.vue";
import type { LayoutDirection } from "./types";

const constraintCount = computed(
  () => store.state.nodes.filter((n) => n.type === "constraint").length,
);
const premiseCount = computed(() => store.state.nodes.filter((n) => n.type === "premise").length);

const { t } = useI18n();

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

onMounted(() => {
  void store.reload();
});

function refresh(): void {
  void store.reload();
}
</script>

<template>
  <NConfigProvider
    :theme="naiveTheme"
    :locale="naiveLocale"
    :date-locale="naiveDateLocale"
    :theme-overrides="{ common: { primaryColor: '#18a058', borderRadius: '8px' } }"
  >
    <NMessageProvider>
      <NGlobalStyle />
      <!-- Own flex shell: naive's NLayout boxes carry no layout of their own. -->
      <div class="shell" :class="{ dark: store.state.theme === 'dark' }">
        <NLayoutHeader class="header" bordered>
          <AppHeader v-model:direction="direction" @refresh="refresh" />
        </NLayoutHeader>
        <div class="content">
          <NAlert
            v-if="store.state.loadError !== null"
            class="load-error"
            type="error"
            :show-icon="true"
            closable
          >
            {{ t("app.loadError") }}: {{ store.state.loadError }}
          </NAlert>
          <div class="workbench">
            <NodeListPanel type="constraint" side="left" />
            <div class="center-pane">
              <DecisionGraph :direction="direction" />
              <GraphFloat placement="top-right">
                <NPopselect v-model:value="direction" :options="directionOptions" trigger="click">
                  <NButton circle :title="t('app.direction')">{{ direction }}</NButton>
                </NPopselect>
              </GraphFloat>
              <GraphFloat placement="bottom-left">
                <div class="status-pill">
                  <span>{{ t("status.constraints") }}: {{ constraintCount }}</span>
                  <span>{{ t("status.premises") }}: {{ premiseCount }}</span>
                  <span v-if="store.state.issues.length > 0" class="issues">
                    {{ t("status.issues") }}: {{ store.state.issues.length }}
                  </span>
                  <span v-if="store.state.selectedId !== null" class="mono">
                    {{ t("status.selected") }}: {{ store.state.selectedId }}
                  </span>
                </div>
              </GraphFloat>
            </div>
            <NodeListPanel type="premise" side="right" />
            <NodeDetailWindow />
          </div>
        </div>
      </div>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style scoped>
/* Theme-aware tokens consumed by the plain (non-naive) panes and the SVG
 * graph, which do not receive naive's theme variables. */
.shell {
  --refino-border: rgba(0, 0, 0, 0.1);
  --refino-radius: 8px;
  --refino-surface: #ffffff;
  --refino-node-bg: rgba(128, 128, 128, 0.08);
  --refino-node-border: rgba(128, 128, 128, 0.4);
  --refino-edge: rgba(128, 128, 128, 0.5);
}

.shell.dark {
  --refino-border: rgba(255, 255, 255, 0.12);
  --refino-surface: rgb(24, 24, 28);
  --refino-node-bg: rgba(255, 255, 255, 0.06);
  --refino-node-border: rgba(255, 255, 255, 0.28);
  --refino-edge: rgba(255, 255, 255, 0.3);
}

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
  position: relative;
  flex: 1;
  min-width: 0;
  overflow: auto;
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
