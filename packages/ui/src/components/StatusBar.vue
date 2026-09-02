<script setup lang="ts">
// Bottom status bar: node counts at the left, current selection centered.
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { store } from "../store";

const { t } = useI18n();

const constraints = computed(() => store.state.nodes.filter((n) => n.type === "constraint").length);
const premises = computed(() => store.state.nodes.filter((n) => n.type === "premise").length);
</script>

<template>
  <footer class="status-bar">
    <div class="side">
      <span>{{ t("status.constraints") }}: {{ constraints }}</span>
      <span>{{ t("status.premises") }}: {{ premises }}</span>
      <span v-if="store.state.issues.length > 0" class="issues">
        {{ t("status.issues") }}: {{ store.state.issues.length }}
      </span>
    </div>
    <div class="center mono">
      <span v-if="store.state.selectedId !== null">
        {{ t("status.selected") }}: {{ store.state.selectedId }}
      </span>
    </div>
    <div class="side right" />
  </footer>
</template>

<style scoped>
.status-bar {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  padding: 0 12px;
  font-size: 12px;
  height: 100%;
  border-top: 1px solid var(--refino-border);
  opacity: 0.85;
}

.side {
  display: flex;
  gap: 16px;
}

.side.right {
  justify-content: flex-end;
}

.issues {
  color: #d03050;
}

.mono {
  font-family: monospace;
}
</style>
