<script setup lang="ts">
// Status pill: read-only canvas statistics and warnings (truncation, render
// culling, issue count, current focus). Sits in the bottom-left float
// corner and never takes input.
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { injectRequired } from "../context";
import { renderCulled } from "../renderStatus";
import { workspaceKey } from "../workspace";

const { t } = useI18n();

const workspace = injectRequired(workspaceKey, "workspace");

const constraintCount = computed(
  () => workspace.displayed.value.filter((n) => n.type === "constraint").length,
);
</script>

<template>
  <div class="status-pill">
    <span>{{ t("status.constraints") }}: {{ constraintCount }}</span>
    <span v-if="workspace.state.truncated" class="issues">
      {{ t("canvas.truncated") }}
    </span>
    <span v-if="renderCulled" class="issues">
      {{ t("canvas.renderCulled") }}
    </span>
    <span v-if="workspace.state.issues.length > 0" class="issues">
      {{ t("status.issues") }}: {{ workspace.state.issues.length }}
    </span>
    <span v-if="workspace.state.focusId !== null" class="mono">
      {{ t("status.selected") }}: {{ workspace.state.focusId }}
    </span>
    <span class="hint">{{ t("app.peekHint") }}</span>
  </div>
</template>

<style scoped>
.status-pill {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 12px;
  font-size: 12px;
  border-radius: var(--refino-radius);
  background: var(--refino-surface);
  border: 1px solid var(--refino-border);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
  opacity: 0.92;
}

.status-pill .issues {
  color: #d03050;
}

.status-pill .mono {
  font-family: monospace;
}
</style>
