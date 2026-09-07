<script setup lang="ts">
// Layout controls: layout mode, display direction and the premises layer
// toggle. All three are persisted canvas config values, written through
// workspace.setConfig like every other setting.
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { NButton, NPopselect } from "naive-ui";
import { injectRequired } from "../context";
import { workspaceKey } from "../workspace";
import type { LayoutDirection } from "../types";
import type { LayoutMode } from "../graph/layout/types";

const { t } = useI18n();

const workspace = injectRequired(workspaceKey, "workspace");

// Writable computeds keep the v-model wiring local; the values live in the
// persisted canvas config.
const direction = computed<LayoutDirection>({
  get: () => workspace.state.config.direction,
  set: (value) => workspace.setConfig({ direction: value }),
});

const showPremises = computed<boolean>({
  get: () => workspace.state.config.showPremises,
  set: (value) => workspace.setConfig({ showPremises: value }),
});

const directionOptions = [
  { label: "→", value: "LR" },
  { label: "↓", value: "TB" },
  { label: "←", value: "RL" },
  { label: "↑", value: "BT" },
];

// Layout selection and display direction live in the persisted canvas
// config; both apply to every layout (the force layout's main axis is
// signed by the direction).
const layoutMode = computed(() => workspace.state.config.layoutMode);
const layoutOptions = computed(() => [
  { label: t("app.layoutLayered"), value: "layered" },
  { label: t("app.layoutForce"), value: "force" },
]);

function setLayoutMode(mode: LayoutMode): void {
  workspace.setConfig({ layoutMode: mode });
}
</script>

<template>
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
    <NPopselect v-model:value="direction" :options="directionOptions" trigger="click">
      <NButton circle :title="t('app.direction')">
        {{ direction }}
      </NButton>
    </NPopselect>
    <NButton
      circle
      :type="showPremises ? 'primary' : 'default'"
      :secondary="showPremises"
      :title="t('canvas.premises')"
      @click="showPremises = !showPremises"
    >
      ⌇
    </NButton>
  </div>
</template>

<style scoped>
.layout-controls {
  display: flex;
  gap: 8px;
}
</style>
