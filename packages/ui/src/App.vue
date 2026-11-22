<script setup lang="ts">
// Application shell: header, sidebars, the canvas pane (graph + edge float
// controls, see GraphArea) and the detail window. Graph data flows through
// the on-demand workspace; the shell only wires lifecycle and global
// actions.
import { computed, inject, onBeforeUnmount, onMounted, provide, watchEffect } from "vue";
import { useI18n } from "vue-i18n";
import {
  NAlert,
  NConfigProvider,
  NDialogProvider,
  NGlobalStyle,
  NLayoutHeader,
  NMessageProvider,
  darkTheme,
  zhCN,
  dateZhCN,
  enUS,
  dateEnUS,
} from "naive-ui";
import { clientKey } from "./api";
import { injectRequired } from "./context";
import { installAltTracking, peekState } from "./peek";
import { createNodeOps, nodeOpsKey } from "./nodeOps";
import { reviewKey } from "./review";
import { installShortcuts } from "./shortcuts";
import { storeKey } from "./store";
import { hasOpenDismissable } from "./useDismissable";
import { workspaceKey } from "./workspace";
import AppHeader from "./components/AppHeader.vue";
import ResourceExplorer from "./components/ResourceExplorer.vue";
import GraphArea from "./components/GraphArea.vue";
import NodeDetailWindow from "./components/NodeDetailWindow.vue";
import CommandPalette from "./components/CommandPalette.vue";
import ShortcutHelp from "./components/ShortcutHelp.vue";
import ReviewDrawer from "./components/ReviewDrawer.vue";
import WorkspaceToasts from "./components/WorkspaceToasts.vue";
import CanvasDialogs from "./components/CanvasDialogs.vue";
import type { LayoutDirection } from "./types";

const client = injectRequired(clientKey, "client");
const store = injectRequired(storeKey, "store");
const workspace = injectRequired(workspaceKey, "workspace");
const review = injectRequired(reviewKey, "review");

const { t, locale } = useI18n();

/** Canvas-side node operations (connect gesture, guarded delete), shared
 * with the context menu and the shortcut commands via injection. */
const nodeOps = createNodeOps(client, store, workspace, t);
provide(nodeOpsKey, nodeOps);

// The store owns the persisted language preference; keep vue-i18n in sync.
watchEffect(() => {
  locale.value = store.state.locale;
});

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
  // Alt-peek modifier tracking (DESIGN.md, "交互"); cleaned up on unmount.
  onBeforeUnmount(installAltTracking());
  // Global shortcut dispatch over the command registry (DESIGN.md, "交互").
  onBeforeUnmount(installShortcuts({ store, workspace, nodeOps }));
});
onBeforeUnmount(() => {
  workspace.stop();
});

function refresh(): void {
  void workspace.reload();
}

/** Naive's transient menus stay mounted while shown and do not always
 * consume Escape themselves; leaving them open while the selection is wiped
 * would skip a layer. */
function hasOpenMenu(): boolean {
  return document.querySelector(".n-base-select-menu, .n-dropdown-menu, .n-popover") !== null;
}

// Esc peels one surface at a time: the editor, palette and help consume it
// themselves; the peek card, drawer, float panels and transient menus are
// tracked here. Only when no surface is open does Esc clear the selection.
function onKeydown(event: KeyboardEvent): void {
  if (
    event.key !== "Escape" ||
    store.state.detailOpen ||
    review.state.open ||
    hasOpenDismissable() ||
    hasOpenMenu() ||
    (peekState.alt && peekState.id !== null)
  ) {
    return;
  }
  workspace.clearSelection();
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
      <NDialogProvider>
        <WorkspaceToasts />
        <CanvasDialogs />
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
                <GraphArea />
                <NodeDetailWindow />
              </div>
            </div>
          </div>
          <CommandPalette />
          <ShortcutHelp />
        </div>
      </NDialogProvider>
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
</style>
