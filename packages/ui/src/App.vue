<script setup lang="ts">
// Application shell: header, sidebar, graph canvas, detail panel, status bar.
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  NConfigProvider,
  NLayout,
  NLayoutContent,
  NLayoutFooter,
  NLayoutHeader,
  NLayoutSider,
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
    <NLayout class="shell">
      <NLayoutHeader class="header" bordered>
        <AppHeader v-model:direction="direction" @refresh="refresh" />
      </NLayoutHeader>
      <NLayoutContent class="content" :native-scrollbar="false">
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
      </NLayoutContent>
      <NLayoutFooter class="footer" bordered>
        <StatusBar />
      </NLayoutFooter>
    </NLayout>
  </NConfigProvider>
</template>

<style scoped>
.shell {
  height: 100vh;
}

.header {
  height: 48px;
}

.content {
  height: calc(100vh - 48px - 28px);
}

.workbench {
  display: grid;
  grid-template-columns: 240px 1fr 320px;
  height: 100%;
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
  height: 28px;
}
</style>
