<script setup lang="ts">
// Right-hand column: the focused node's dossier, or the editor sheet when
// one is open. Resizable and collapsible to a rail so the canvas can take
// the whole width; both choices persist like every other view preference.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { NIcon } from "naive-ui";
import { ChevronBackOutline, DocumentTextOutline } from "@vicons/ionicons5";
import { injectRequired } from "../context";
import { readNumberPreference, readPreference, writePreference } from "../preferences";
import { storeKey } from "../store";
import NodeDossier from "./NodeDossier.vue";
import NodeEditor from "./NodeEditor.vue";

const { t } = useI18n();
const store = injectRequired(storeKey, "store");

const COLLAPSE_KEY = "refino.panel.collapsed";
const WIDTH_KEY = "refino.panel.width";
const WIDTH_MIN = 268;
const WIDTH_MAX = 560;

const clamp = (value: number): number => Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, value));

const collapsed = ref(readPreference<string>(COLLAPSE_KEY, "false") === "true");
const width = ref(clamp(readNumberPreference(WIDTH_KEY, 340)));
const editing = computed(() => store.state.editorOpen);
const style = computed(() => (collapsed.value ? undefined : { width: `${width.value}px` }));

function setCollapsed(value: boolean): void {
  collapsed.value = value;
  writePreference(COLLAPSE_KEY, String(value));
}

// The sheet always unfolds the pane; opening it behind the rail would look
// like the command did nothing.
watch(editing, (value) => {
  if (value) setCollapsed(false);
});

let startX = 0;
let startWidth = 0;

function onResizeStart(event: MouseEvent): void {
  startX = event.clientX;
  startWidth = width.value;
  window.addEventListener("mousemove", onResizeMove);
  window.addEventListener("mouseup", onResizeEnd);
}

function onResizeMove(event: MouseEvent): void {
  // Dragging the pane's outer edge left widens it.
  width.value = clamp(startWidth - (event.clientX - startX));
}

function onResizeEnd(): void {
  writePreference(WIDTH_KEY, String(width.value));
  window.removeEventListener("mousemove", onResizeMove);
  window.removeEventListener("mouseup", onResizeEnd);
}

onBeforeUnmount(onResizeEnd);
</script>

<template>
  <aside class="node-panel" :class="{ collapsed }" :style="style">
    <template v-if="!collapsed">
      <NodeEditor v-if="editing" />
      <NodeDossier v-else @collapse="setCollapsed(true)" />
      <div class="resize" :title="t('dossier.resize')" @mousedown.prevent="onResizeStart" />
    </template>
    <button v-else class="rail" :title="t('dossier.expand')" @click="setCollapsed(false)">
      <NIcon :component="ChevronBackOutline" />
      <NIcon :component="DocumentTextOutline" />
      <span class="rail-label">{{ t("dossier.title") }}</span>
    </button>
  </aside>
</template>

<style scoped>
.node-panel {
  flex: none;
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-width: 60vw;
  border-left: 1px solid var(--refino-border);
  background: var(--refino-surface);
}

.node-panel.collapsed {
  width: 40px;
}

/* The collapsed rail: one tap target that names what unfolds. */
.rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 100%;
  padding: 12px 0;
  border: none;
  background: transparent;
  color: var(--refino-text-faint);
  cursor: pointer;
  font: inherit;
}

.rail:hover {
  color: var(--refino-text);
}

.rail-label {
  writing-mode: vertical-rl;
  font-size: 11px;
  letter-spacing: 0.12em;
}

.resize {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -3px;
  width: 6px;
  cursor: col-resize;
  z-index: 5;
}

.resize:hover {
  background: var(--refino-accent-soft);
}
</style>
