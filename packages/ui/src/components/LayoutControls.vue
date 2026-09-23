<script setup lang="ts">
// Layout controls: layout mode, display direction, the premises layer
// toggle and the layout tuning panel. All values are persisted canvas
// config entries, written through workspace.setConfig like every other
// setting. The panel holds the common layer gap plus the force-directed
// tuning coefficients (the force section only shows in force mode).
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { NButton, NCheckbox, NPopselect, NSlider } from "naive-ui";
import { injectRequired } from "../context";
import { workspaceKey } from "../workspace";
import { useDismissable } from "../useDismissable";
import { LAYER_GAP, LAYER_GAP_MAX, LAYER_GAP_MIN } from "../graph/layout/engine";
import { FORCE_TUNING_DEFAULT, FORCE_TUNING_MAX, FORCE_TUNING_MIN } from "../graph/layout/force";
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
  { label: t("app.layoutRail"), value: "rail" },
]);

function setLayoutMode(mode: LayoutMode): void {
  workspace.setConfig({ layoutMode: mode });
}

// Layout tuning panel: the common layer gap and the force-directed
// coefficients, each backed by a persisted config entry. Like every float
// panel, an outside press or Escape collapses it.
const tuning = ref(false);
const tuningRoot = ref<HTMLElement | null>(null);
useDismissable(tuning, tuningRoot);
const layerGap = computed<number>({
  get: () => workspace.state.config.layerGap,
  set: (value) => workspace.setConfig({ layerGap: value }),
});
const forceGravity = computed<number>({
  get: () => workspace.state.config.forceGravity,
  set: (value) => workspace.setConfig({ forceGravity: value }),
});
const forceFriction = computed<number>({
  get: () => workspace.state.config.forceFriction,
  set: (value) => workspace.setConfig({ forceFriction: value }),
});
const forceRepulsion = computed<number>({
  get: () => workspace.state.config.forceRepulsion,
  set: (value) => workspace.setConfig({ forceRepulsion: value }),
});
const forceSpring = computed<number>({
  get: () => workspace.state.config.forceSpring,
  set: (value) => workspace.setConfig({ forceSpring: value }),
});
function resetTuning(): void {
  workspace.setConfig({
    layerGap: LAYER_GAP,
    forceGravity: FORCE_TUNING_DEFAULT.gravity,
    forceFriction: FORCE_TUNING_DEFAULT.friction,
    forceRepulsion: FORCE_TUNING_DEFAULT.repulsion,
    forceSpring: FORCE_TUNING_DEFAULT.spring,
  });
}
// Display-only virtual root (force layouts): pure visibility, toggling it
// never restarts the layout.
const showVirtualRoot = computed<boolean>({
  get: () => workspace.state.config.showVirtualRoot,
  set: (value) => workspace.setConfig({ showVirtualRoot: value }),
});
</script>

<template>
  <div class="layout-controls">
    <div ref="tuningRoot" class="tuning">
      <section v-if="tuning" class="panel">
        <div class="row">
          <span>{{ t("canvas.layerGap") }}</span>
          <span class="value">{{ layerGap }}</span>
        </div>
        <NSlider
          v-model:value="layerGap"
          :min="LAYER_GAP_MIN"
          :max="LAYER_GAP_MAX"
          :step="1"
          :tooltip="false"
        />
        <template v-if="layoutMode === 'force'">
          <div class="row">
            <span>{{ t("canvas.forceGravity") }}</span>
            <span class="value">{{ forceGravity.toFixed(3) }}</span>
          </div>
          <NSlider
            v-model:value="forceGravity"
            :min="FORCE_TUNING_MIN.gravity"
            :max="FORCE_TUNING_MAX.gravity"
            :step="0.005"
            :tooltip="false"
          />
          <div class="row">
            <span>{{ t("canvas.forceFriction") }}</span>
            <span class="value">{{ Math.round(forceFriction * 100) }}%</span>
          </div>
          <NSlider
            v-model:value="forceFriction"
            :min="FORCE_TUNING_MIN.friction"
            :max="FORCE_TUNING_MAX.friction"
            :step="0.01"
            :tooltip="false"
          />
          <div class="row">
            <span>{{ t("canvas.forceRepulsion") }}</span>
            <span class="value">{{ Math.round(forceRepulsion) }}</span>
          </div>
          <NSlider
            v-model:value="forceRepulsion"
            :min="FORCE_TUNING_MIN.repulsion"
            :max="FORCE_TUNING_MAX.repulsion"
            :step="5"
            :tooltip="false"
          />
          <div class="row">
            <span>{{ t("canvas.forceSpring") }}</span>
            <span class="value">{{ forceSpring.toFixed(2) }}</span>
          </div>
          <NSlider
            v-model:value="forceSpring"
            :min="FORCE_TUNING_MIN.spring"
            :max="FORCE_TUNING_MAX.spring"
            :step="0.01"
            :tooltip="false"
          />
          <NCheckbox v-model:checked="showVirtualRoot" size="small">
            {{ t("canvas.showVirtualRoot") }}
          </NCheckbox>
        </template>
        <NButton quaternary size="tiny" @click="resetTuning">
          {{ t("canvas.layoutTuningReset") }}
        </NButton>
      </section>
      <NButton
        circle
        :type="tuning ? 'primary' : 'default'"
        :title="t('canvas.layoutTuning')"
        @click="tuning = !tuning"
      >
        ⚙
      </NButton>
    </div>
    <NPopselect
      :value="layoutMode"
      :options="layoutOptions"
      trigger="click"
      @update:value="setLayoutMode"
    >
      <NButton circle :title="t('app.layout')">
        <span v-if="layoutMode === 'layered'">≡</span>
        <span v-else-if="layoutMode === 'rail'">∥</span>
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

/* The tuning button wraps its overlay panel so the panel anchors to the
 * button without reflowing the sibling controls (ui DESIGN.md, "布局"). */
.tuning {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.panel {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 200px;
  padding: 12px;
  border-radius: var(--refino-radius);
  background: var(--refino-surface);
  border: 1px solid var(--refino-border);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
}

.row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 12px;
}

.value {
  font-family: monospace;
}
</style>
