<script setup lang="ts">
// Application shell: header, dual sidebars, canvas with floating layers,
// detail bar. Graph data flows through the on-demand workspace; the shell
// only wires lifecycle, global actions and status display.
import { computed, inject, onBeforeUnmount, onMounted, ref, watchEffect } from "vue";
import { useI18n } from "vue-i18n";
import {
  NAlert,
  NConfigProvider,
  NGlobalStyle,
  NLayoutHeader,
  NMessageProvider,
  darkTheme,
  zhCN,
  dateZhCN,
  enUS,
  dateEnUS,
} from "naive-ui";
import { injectRequired } from "./context";
import { installAltTracking } from "./peek";
import { renderCulled } from "./renderStatus";
import { storeKey } from "./store";
import { workspaceKey } from "./workspace";

const store = injectRequired(storeKey, "store");
const workspace = injectRequired(workspaceKey, "workspace");
import AppHeader from "./components/AppHeader.vue";
import ResourceExplorer from "./components/ResourceExplorer.vue";
import DecisionGraph from "./components/DecisionGraph.vue";
import CanvasStyleSettings from "./components/CanvasStyleSettings.vue";
import LayoutControls from "./components/LayoutControls.vue";
import NodeSizeControl from "./components/NodeSizeControl.vue";
import NodeDetailWindow from "./components/NodeDetailWindow.vue";
import NodePeek from "./components/NodePeek.vue";
import GraphFloat from "./components/GraphFloat.vue";
import CommandPalette from "./components/CommandPalette.vue";
import ReviewDrawer from "./components/ReviewDrawer.vue";
import SelectionList from "./components/SelectionList.vue";
import StatusPill from "./components/StatusPill.vue";
import WorkspaceToasts from "./components/WorkspaceToasts.vue";
import type { LayoutDirection } from "./types";

const { t, locale } = useI18n();

// The store owns the persisted language preference; keep vue-i18n in sync.
watchEffect(() => {
  locale.value = store.state.locale;
});

// The graph host reports per-frame render culling into the shared status
// state; the status pill reads it from there.
function onRenderCulled(value: boolean): void {
  renderCulled.value = value;
}

const naiveTheme = computed(() => (store.state.theme === "dark" ? darkTheme : null));
const naiveLocale = computed(() => (locale.value === "zh" ? zhCN : enUS));
const naiveDateLocale = computed(() => (locale.value === "zh" ? dateZhCN : dateEnUS));

// The display direction is a canvas config value, persisted like the rest
// of the config; a writable computed keeps the v-model wiring local.
const direction = computed<LayoutDirection>({
  get: () => workspace.state.config.direction,
  set: (value) => workspace.setConfig({ direction: value }),
});

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
          <AppHeader v-model:direction="direction" @refresh="refresh">
            <ReviewDrawer />
          </AppHeader>
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
                  @render-culled="onRenderCulled"
                />
                <GraphFloat placement="top-right">
                  <SelectionList />
                </GraphFloat>
                <GraphFloat placement="bottom-right">
                  <CanvasStyleSettings />
                  <NodeSizeControl />
                  <LayoutControls />
                </GraphFloat>
                <GraphFloat placement="bottom-left">
                  <StatusPill />
                </GraphFloat>
                <NodePeek />
              </div>
              <NodeDetailWindow />
            </div>
          </div>
        </div>
        <CommandPalette />
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
</style>
