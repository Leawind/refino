<script setup lang="ts">
// Application shell: header, sidebar, graph canvas, detail panel, status bar.
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  NAlert,
  NButton,
  NConfigProvider,
  NGlobalStyle,
  NLayoutFooter,
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
import StatusBar from "./components/StatusBar.vue";
import type { LayoutDirection } from "./types";

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
    :theme-overrides="{ common: { primaryColor: '#18a058' } }"
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
              <div class="graph-title">{{ t("app.graph") }}</div>
              <DecisionGraph :direction="direction" />
              <div class="graph-actions">
                <NPopselect v-model:value="direction" :options="directionOptions" trigger="click">
                  <NButton circle :title="t('app.direction')">{{ direction }}</NButton>
                </NPopselect>
                <NButton
                  size="small"
                  :title="t('node.createPremise')"
                  @click="store.startCreate('premise')"
                >
                  +{{ t("node.premise") }}
                </NButton>
                <NButton
                  size="small"
                  :title="t('node.createConstraint')"
                  @click="store.startCreate('constraint')"
                >
                  +{{ t("node.constraint") }}
                </NButton>
              </div>
              <NodeDetailWindow />
            </div>
            <NodeListPanel type="premise" side="right" />
          </div>
        </div>
        <NLayoutFooter class="footer" bordered>
          <StatusBar />
        </NLayoutFooter>
      </div>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style scoped>
/* Theme-aware tokens consumed by the plain (non-naive) panes and the SVG
 * graph, which do not receive naive's theme variables. */
.shell {
  --refino-border: rgba(0, 0, 0, 0.1);
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
  height: 100vh;
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
}

.center-pane {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow: auto;
}

.graph-title {
  position: absolute;
  top: 10px;
  left: 12px;
  z-index: 5;
  font-size: 12px;
  font-weight: 600;
  opacity: 0.65;
  pointer-events: none;
}

.graph-actions {
  position: absolute;
  top: 10px;
  right: 12px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.footer {
  flex: none;
  height: 28px;
}
</style>
