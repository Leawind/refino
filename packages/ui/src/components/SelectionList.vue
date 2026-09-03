<script setup lang="ts">
// Ordered selection list as a floating layer over the canvas (README,
// "交互"): click locates (makes the entry the focus), the per-item button
// removes, the head button clears.
import { useI18n } from "vue-i18n";
import { workspace } from "../workspace";

const { t } = useI18n();

// A top-level binding so the template sees the unwrapped array.
const selectedNodes = workspace.selectedNodes;
</script>

<template>
  <div v-if="workspace.state.selection.length > 0" class="selection-list">
    <div class="head">
      <span class="title">{{ t("selection.title") }} ({{ workspace.state.selection.length }})</span>
      <button class="btn" :title="t('selection.clear')" @click="workspace.clearSelection()">
        ✕
      </button>
    </div>
    <ul>
      <li
        v-for="node in selectedNodes"
        :key="node.id"
        :class="{ focus: node.id === workspace.state.focusId }"
        :title="t('selection.locate')"
        @click="workspace.setFocus(node.id)"
      >
        <span class="marker" />
        <span class="summary">
          {{ node.summary === "" ? t("node.untitled") : node.summary }}
        </span>
        <span class="id">{{ node.id }}</span>
        <button
          class="btn"
          :title="t('selection.remove')"
          @click.stop="workspace.removeFromSelection(node.id)"
        >
          ×
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.selection-list {
  max-width: 260px;
  max-height: 40vh;
  display: flex;
  flex-direction: column;
  font-size: 12px;
  background: var(--refino-surface);
  border: 1px solid var(--refino-border);
  border-radius: var(--refino-radius);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
  opacity: 0.95;
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--refino-border);
}

.title {
  opacity: 0.7;
}

ul {
  margin: 0;
  padding: 4px;
  list-style: none;
  overflow-y: auto;
}

li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  border-radius: 6px;
  cursor: pointer;
}

li:hover {
  background: rgba(128, 128, 128, 0.12);
}

li.focus {
  background: rgba(24, 160, 88, 0.15);
}

.marker {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--refino-primary, #18a058);
}

li.focus .marker {
  outline: 2px solid var(--refino-primary, #18a058);
  outline-offset: 1px;
}

.summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.id {
  font-family: monospace;
  font-size: 10px;
  opacity: 0.55;
}

.btn {
  flex: none;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  padding: 0 2px;
  opacity: 0.6;
}

.btn:hover {
  opacity: 1;
  color: var(--refino-primary, #18a058);
}
</style>
