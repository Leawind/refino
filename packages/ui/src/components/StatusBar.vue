<script setup lang="ts">
// Bottom status bar: node counts and the current selection.
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { store } from "../store";

const { t } = useI18n();

const constraints = computed(() => store.state.nodes.filter((n) => n.type === "constraint").length);
const premises = computed(() => store.state.nodes.filter((n) => n.type === "premise").length);
</script>

<template>
  <footer class="status-bar">
    <span>{{ t("status.constraints") }}: {{ constraints }}</span>
    <span>{{ t("status.premises") }}: {{ premises }}</span>
    <span v-if="store.state.issues.length > 0" class="issues">
      {{ t("status.issues") }}: {{ store.state.issues.length }}
    </span>
    <span class="spacer" />
    <span v-if="store.state.selectedId !== null" class="mono">
      {{ t("status.selected") }}: {{ store.state.selectedId }}
    </span>
  </footer>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 12px;
  font-size: 12px;
  height: 100%;
  border-top: 1px solid var(--refino-border);
  opacity: 0.85;
}

.spacer {
  flex: 1;
}

.issues {
  color: #d03050;
}

.mono {
  font-family: monospace;
}
</style>
