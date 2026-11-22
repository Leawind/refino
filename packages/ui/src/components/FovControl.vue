<script setup lang="ts">
// Field-of-view control of the orbit view (ui DESIGN.md, "三维视图"): a
// bottom-right button expands a slider for the narrower viewing angle, the
// same parameter the Ctrl+wheel adjusts. Values ride the orbit viewport
// bridge; without a camera the button stays inert.
import { onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { NButton, NIcon, NSlider } from "naive-ui";
import { ApertureOutline } from "@vicons/ionicons5";
import { useDismissable } from "../useDismissable";
import { viewportBridge } from "../viewportBridge";

const { t } = useI18n();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const fov = ref(45);
const min = ref(40);
const max = ref(120);
let unsubscribe: (() => void) | null = null;

/** The scene reports the angle it is heading for, so the knob stays put
 * while the camera eases behind it. */
function read(): void {
  const state = viewportBridge.commands?.getFov?.() ?? null;
  if (state === null) return;
  fov.value = Math.round(state.value);
  min.value = state.min;
  max.value = state.max;
}

watch(
  () => viewportBridge.commands,
  (commands) => {
    unsubscribe?.();
    unsubscribe = null;
    if (commands === null) return;
    read();
    unsubscribe = commands.onCameraChanged(read);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  unsubscribe?.();
  unsubscribe = null;
});

function onSlide(value: number): void {
  fov.value = value;
  viewportBridge.commands?.setFov?.(value);
}

useDismissable(open, root);
</script>

<template>
  <div ref="root" class="fov-control">
    <NButton
      circle
      :type="open ? 'primary' : 'default'"
      :title="t('app.fov')"
      :disabled="viewportBridge.commands === null"
      @click="open = !open"
    >
      <NIcon :component="ApertureOutline" />
    </NButton>
    <!-- The panel overlays the pane from the button's corner, so opening it
         never reflows the sibling edge controls (ui DESIGN.md, "布局"). -->
    <section v-if="open" class="panel">
      <div class="row">
        <span>{{ t("app.fov") }}</span>
        <span class="value">{{ Math.round(fov) }}°</span>
      </div>
      <NSlider
        :value="fov"
        :min="min"
        :max="max"
        :step="1"
        :tooltip="false"
        @update:value="onSlide"
      />
    </section>
  </div>
</template>

<style scoped>
.fov-control {
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
  width: 180px;
  padding: 10px 12px;
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
