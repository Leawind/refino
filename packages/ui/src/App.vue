<script setup lang="ts">
// Application shell: finder, canvas and the node pane side by side, with no
// chrome band of its own (ui DESIGN.md, "布局"): the top bar dissolved into
// the finder's head, and every global action lives in its system menu.
// Graph data flows through the on-demand workspace; the shell only wires
// lifecycle and the Esc chain.
import { computed, inject, onBeforeUnmount, onMounted, provide, watchEffect } from "vue";
import { useI18n } from "vue-i18n";
import {
  NAlert,
  NConfigProvider,
  NDialogProvider,
  NGlobalStyle,
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
import ResourceExplorer from "./components/ResourceExplorer.vue";
import GraphArea from "./components/GraphArea.vue";
import NodePanel from "./components/NodePanel.vue";
import CommandPalette from "./components/CommandPalette.vue";
import ShortcutHelp from "./components/ShortcutHelp.vue";
import WorkspaceToasts from "./components/WorkspaceToasts.vue";
import CanvasDialogs from "./components/CanvasDialogs.vue";

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

/** The 3D view carries its own focus content; the read pane only joins it
 * for an editing session (ui DESIGN.md, "三维视图"). */
const orbit = computed(() => workspace.state.config.canvasView === "orbit");
const showPanel = computed(() => !orbit.value || store.state.editorOpen);

const themeOverrides = computed(() => ({
  common: {
    primaryColor: "#18a058",
    primaryColorHover: "#20b46a",
    primaryColorPressed: "#148a4c",
    borderRadius: "8px",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "Microsoft YaHei", sans-serif',
  },
}));

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

// Esc peels one surface at a time: the editor sheet, palette, help and naive
// menus consume it themselves; the peek card, drawer and float panels are
// tracked here. Only when no surface is open does Esc clear the selection.
function onKeydown(event: KeyboardEvent): void {
  if (
    event.key !== "Escape" ||
    store.state.editorOpen ||
    review.state.open ||
    hasOpenDismissable() ||
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
    :theme-overrides="themeOverrides"
  >
    <NMessageProvider>
      <NDialogProvider>
        <WorkspaceToasts />
        <CanvasDialogs />
        <NGlobalStyle />
        <div class="shell">
          <div class="workbench">
            <ResourceExplorer />
            <div class="center-pane">
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
              <GraphArea />
            </div>
            <NodePanel v-if="showPanel" />
          </div>
        </div>
        <CommandPalette />
        <ShortcutHelp />
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
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* A load failure is a transient overlay on the canvas, not a band that
 * pushes the layout (ui DESIGN.md, "画布最大化"). */
.load-error {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  width: min(560px, calc(100% - 32px));
  box-shadow: var(--refino-shadow-2);
}
</style>
