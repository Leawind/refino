<script setup lang="ts">
// Orbit view settings (ui DESIGN.md, "三维视图"): one bottom-right button
// expands the grouped parameters of the 3D view — the field of view, how far
// a right drag turns the ball, the light of the starfield, the lineage flow,
// the callout text size, the force balance and the satellite revolution. The
// field of view rides the viewport bridge; everything else is a persisted
// canvas config entry, so the values also hold for the next view switch.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { NButton, NIcon, NSlider } from "naive-ui";
import { OptionsOutline, RefreshOutline } from "@vicons/ionicons5";
import {
  DEFAULT_FOV,
  DEFAULT_ROTATE_SENSITIVITY,
  MAX_FOV,
  MIN_FOV,
  ROTATE_SENSITIVITY_MAX,
  ROTATE_SENSITIVITY_MIN,
} from "../graph/orbit/camera";
import {
  ORBIT_SETTING_LIMITS,
  ORBIT_SETTINGS_DEFAULT,
  ORBIT_TEXT_SCALE_DEFAULT,
  ORBIT_TEXT_SCALE_MAX,
  ORBIT_TEXT_SCALE_MIN,
} from "../graph/orbit/settings";
import type { OrbitSettingLimit, OrbitSettings } from "../graph/orbit/settings";
import { injectRequired } from "../context";
import { useDismissable } from "../useDismissable";
import { viewportBridge } from "../viewportBridge";
import { workspaceKey } from "../workspace";
import type { CanvasConfig } from "../workspace";

/** One slider of the panel: a value, its range and how to write it back. */
interface SettingRow {
  key: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** The tuned baseline the reset button returns to. */
  reset: number;
  format: (value: number) => string;
  set: (value: number) => void;
}

interface SettingGroup {
  key: string;
  label: string;
  rows: SettingRow[];
}

const { t } = useI18n();
const workspace = injectRequired(workspaceKey, "workspace");

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const fov = ref(DEFAULT_FOV);
const fovMin = ref(MIN_FOV);
const fovMax = ref(MAX_FOV);
let unsubscribe: (() => void) | null = null;

/** The scene reports the angle it is heading for, so the knob stays put
 * while the camera eases behind it. */
function readFov(): void {
  const state = viewportBridge.commands?.getFov?.() ?? null;
  if (state === null) return;
  fov.value = Math.round(state.value);
  fovMin.value = state.min;
  fovMax.value = state.max;
}

watch(
  () => viewportBridge.commands,
  (commands) => {
    unsubscribe?.();
    unsubscribe = null;
    if (commands === null) return;
    readFov();
    unsubscribe = commands.onCameraChanged(readFov);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  unsubscribe?.();
  unsubscribe = null;
});

function onFov(value: number): void {
  fov.value = value;
  viewportBridge.commands?.setFov?.(value);
}

/** A light layer reads as a percentage; a speed or stiffness as a multiple of
 * the tuned baseline. */
const percent = (value: number): string => `${Math.round(value * 100)}%`;
const times = (value: number): string => `${value.toFixed(2)}×`;

/** The config field behind each orbit setting, in panel order. */
const ORBIT_FIELD: Record<
  keyof OrbitSettings,
  | "orbitStarBrightness"
  | "orbitFlowSpeed"
  | "orbitFlowGlow"
  | "orbitSpring"
  | "orbitRepulsion"
  | "orbitRevolutionSpeed"
  | "orbitDamping"
  | "orbitHalo"
> = {
  starBrightness: "orbitStarBrightness",
  flowSpeed: "orbitFlowSpeed",
  flowGlow: "orbitFlowGlow",
  spring: "orbitSpring",
  repulsion: "orbitRepulsion",
  revolutionSpeed: "orbitRevolutionSpeed",
  damping: "orbitDamping",
  halo: "orbitHalo",
};

function orbitRow(
  setting: keyof OrbitSettings,
  label: string,
  limit: OrbitSettingLimit,
  format: (value: number) => string,
): SettingRow {
  const field = ORBIT_FIELD[setting];
  return {
    key: setting,
    label,
    value: workspace.state.config[field],
    min: limit.min,
    max: limit.max,
    step: limit.step,
    reset: ORBIT_SETTINGS_DEFAULT[setting],
    format,
    set: (value) => workspace.setConfig({ [field]: value } as Partial<CanvasConfig>),
  };
}

const groups = computed<SettingGroup[]>(() => {
  const config = workspace.state.config;
  return [
    {
      key: "camera",
      label: t("app.orbitCamera"),
      rows: [
        {
          key: "fov",
          label: t("app.fov"),
          value: fov.value,
          min: fovMin.value,
          max: fovMax.value,
          step: 1,
          reset: DEFAULT_FOV,
          format: (value) => `${Math.round(value)}°`,
          set: onFov,
        },
        {
          key: "rotateSensitivity",
          label: t("app.rotateSensitivity"),
          value: config.rotateSensitivity,
          min: ROTATE_SENSITIVITY_MIN,
          max: ROTATE_SENSITIVITY_MAX,
          step: 0.05,
          reset: DEFAULT_ROTATE_SENSITIVITY,
          format: times,
          set: (value) => workspace.setConfig({ rotateSensitivity: value }),
        },
        orbitRow("damping", t("app.orbitDamping"), ORBIT_SETTING_LIMITS.damping, times),
      ],
    },
    {
      key: "light",
      label: t("app.orbitLight"),
      rows: [
        orbitRow(
          "starBrightness",
          t("app.orbitStarBrightness"),
          ORBIT_SETTING_LIMITS.starBrightness,
          percent,
        ),
        orbitRow("halo", t("app.orbitHalo"), ORBIT_SETTING_LIMITS.halo, percent),
      ],
    },
    {
      key: "flow",
      label: t("app.orbitFlow"),
      rows: [
        orbitRow("flowSpeed", t("app.orbitFlowSpeed"), ORBIT_SETTING_LIMITS.flowSpeed, times),
        orbitRow("flowGlow", t("app.orbitFlowGlow"), ORBIT_SETTING_LIMITS.flowGlow, percent),
      ],
    },
    {
      key: "text",
      label: t("app.orbitText"),
      rows: [
        {
          key: "textScale",
          label: t("app.orbitTextScale"),
          value: config.orbitTextScale,
          min: ORBIT_TEXT_SCALE_MIN,
          max: ORBIT_TEXT_SCALE_MAX,
          step: 0.05,
          reset: ORBIT_TEXT_SCALE_DEFAULT,
          format: percent,
          set: (value) => workspace.setConfig({ orbitTextScale: value }),
        },
      ],
    },
    {
      key: "physics",
      label: t("app.orbitPhysics"),
      rows: [
        orbitRow("spring", t("app.orbitSpring"), ORBIT_SETTING_LIMITS.spring, times),
        orbitRow("repulsion", t("app.orbitRepulsion"), ORBIT_SETTING_LIMITS.repulsion, times),
      ],
    },
    {
      key: "revolution",
      label: t("app.orbitRevolution"),
      rows: [
        orbitRow(
          "revolutionSpeed",
          t("app.orbitRevolutionSpeed"),
          ORBIT_SETTING_LIMITS.revolutionSpeed,
          times,
        ),
      ],
    },
  ];
});

/** Float values come from sliders: compare with a tolerance so a step that
 * lands a hair off the baseline still offers the reset. */
function changed(row: SettingRow): boolean {
  return Math.abs(row.value - row.reset) > 1e-6;
}

useDismissable(open, root);
</script>

<template>
  <div ref="root" class="orbit-control">
    <NButton
      circle
      :type="open ? 'primary' : 'default'"
      :title="t('app.orbitControl')"
      @click="open = !open"
    >
      <NIcon :component="OptionsOutline" />
    </NButton>
    <!-- The panel overlays the pane from the button's corner, so opening it
         never reflows the sibling edge controls (ui DESIGN.md, "布局"). -->
    <section v-if="open" class="panel">
      <div v-for="group in groups" :key="group.key" class="group">
        <h4 class="group-title">{{ group.label }}</h4>
        <div v-for="row in group.rows" :key="row.key" class="setting">
          <div class="head">
            <span class="label">{{ row.label }}</span>
            <span class="value">{{ row.format(row.value) }}</span>
            <NButton
              class="reset"
              :class="{ 'is-idle': !changed(row) }"
              quaternary
              circle
              size="tiny"
              :title="t('app.resetSetting')"
              :disabled="!changed(row)"
              @click="row.set(row.reset)"
            >
              <NIcon :component="RefreshOutline" />
            </NButton>
          </div>
          <NSlider
            :value="row.value"
            :min="row.min"
            :max="row.max"
            :step="row.step"
            :tooltip="false"
            @update:value="row.set"
          />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.orbit-control {
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
  gap: 10px;
  width: 236px;
  max-height: min(70vh, 560px);
  overflow-y: auto;
  padding: 10px 12px;
  border-radius: var(--refino-radius-lg);
  background: var(--refino-surface);
  border: 1px solid var(--refino-border);
  box-shadow: var(--refino-shadow-2);
  scrollbar-width: thin;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.group + .group {
  padding-top: 8px;
  border-top: 1px solid var(--refino-border);
}

.group-title {
  margin: 0;
  color: var(--refino-text-muted);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
}

.setting {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.label {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.value {
  flex: none;
  font-family: var(--refino-font-mono);
  font-variant-numeric: tabular-nums;
}

/* The reset keeps its slot while it is not needed, so the value does not
 * shift as the knob leaves the baseline. */
.reset.is-idle {
  visibility: hidden;
}
</style>
