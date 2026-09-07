<script setup lang="ts">
// Canvas style settings: an edge button opening a small floating panel
// (README, "配置项"). Holds the canvas text size multiplier; the value
// persists through the workspace canvas config like every other setting.
// Like every float panel, an outside press or Escape collapses it.
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { NButton, NSlider } from "naive-ui";
import { injectRequired } from "../context";
import { TEXT_SCALE_MAX, TEXT_SCALE_MIN } from "../graph/render/renderer";
import { workspaceKey } from "../workspace";
import { useDismissable } from "../useDismissable";

const { t } = useI18n();

const workspace = injectRequired(workspaceKey, "workspace");
const open = ref(false);
const root = ref<HTMLElement | null>(null);
useDismissable(open, root);

const textScale = computed<number>({
  get: () => workspace.state.config.textScale,
  set: (value) => workspace.setConfig({ textScale: value }),
});
</script>

<template>
  <div ref="root" class="style-settings">
    <section v-if="open" class="panel">
      <div class="row">
        <span>{{ t("canvas.textSize") }}</span>
        <span class="value">{{ Math.round(textScale * 100) }}%</span>
      </div>
      <NSlider
        v-model:value="textScale"
        :min="TEXT_SCALE_MIN"
        :max="TEXT_SCALE_MAX"
        :step="0.1"
        :tooltip="false"
      />
      <NButton quaternary size="tiny" @click="textScale = 1">
        {{ t("canvas.textSizeReset") }}
      </NButton>
    </section>
    <NButton
      circle
      :type="open ? 'primary' : 'default'"
      :title="t('canvas.styleSettings')"
      @click="open = !open"
    >
      Aa
    </NButton>
  </div>
</template>

<style scoped>
.style-settings {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

/* The panel overlays the pane above the button; it never reflows the
 * sibling edge controls (ui DESIGN.md, "布局"). */
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
