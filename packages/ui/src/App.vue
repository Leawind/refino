<script setup lang="ts">
// Application shell: header, sidebar, graph canvas, detail panel, status bar.
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  NAlert,
  NConfigProvider,
  NLayoutFooter,
  NLayoutHeader,
  NMessageProvider,
  darkTheme,
  zhCN,
  dateZhCN,
  enUS,
  dateEnUS,
} from "naive-ui";
import { store } from "./store";
import { i18n } from "./i18n";
import AppHeader from "./components/AppHeader.vue";
import NodeSidebar from "./components/NodeSidebar.vue";
import CrgGraph from "./components/CrgGraph.vue";
import NodeDetail from "./components/NodeDetail.vue";
import StatusBar from "./components/StatusBar.vue";
import type { LayoutDirection } from "./types";

const { t } = useI18n();

const naiveTheme = computed(() => (store.state.theme === "dark" ? darkTheme : null));
const naiveLocale = computed(() => (i18n.global.locale.value === "zh" ? zhCN : enUS));
const naiveDateLocale = computed(() => (i18n.global.locale.value === "zh" ? dateZhCN : dateEnUS));

const direction = ref<LayoutDirection>("LR");

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
      <!-- Own flex shell: naive's NLayout boxes carry no layout of their own. -->
      <div class="shell">
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
            <div class="sidebar-pane">
              <NodeSidebar />
            </div>
            <div class="graph-pane">
              <CrgGraph :direction="direction" />
            </div>
            <div class="detail-pane">
              <NodeDetail />
            </div>
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
.shell {
  height: 100vh;
  display: flex;
  flex-direction: column;
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
  display: grid;
  grid-template-columns: 280px 1fr 340px;
  flex: 1;
  min-height: 0;
}

.sidebar-pane,
.detail-pane {
  border-right: 1px solid rgba(128, 128, 128, 0.2);
  overflow: hidden;
}

.detail-pane {
  border-right: none;
  border-left: 1px solid rgba(128, 128, 128, 0.2);
}

.graph-pane {
  overflow: auto;
}

.footer {
  flex: none;
  height: 28px;
}
</style>
