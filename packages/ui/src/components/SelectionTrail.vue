<script setup lang="ts">
// Selection trail (ui DESIGN.md, "布局"): the ordered selection is a path
// through the map, so a multiple selection reads as a row of steps at the
// canvas's top edge — the last step is the focus. Clicking a step makes it
// the focus, the cross removes it, and one entry clears the whole trail.
// A single selection needs no trail: the node pane already names it.
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { NIcon } from "naive-ui";
import { CloseOutline } from "@vicons/ionicons5";
import { injectRequired } from "../context";
import { peekHide, peekMove } from "../peek";
import { workspaceKey } from "../workspace";
import type { NodeLite } from "../types";

const workspace = injectRequired(workspaceKey, "workspace");
const { t } = useI18n();

const nodes = workspace.selectedNodes;
const visible = computed(() => workspace.state.selection.length > 1);

function labelOf(node: NodeLite): string {
  return node.summary === "" ? t("node.untitled") : node.summary;
}

function onMove(event: MouseEvent, node: NodeLite): void {
  peekMove(node.id, event.clientX, event.clientY);
}

function remove(node: NodeLite): void {
  workspace.removeFromSelection(node.id);
}
</script>

<template>
  <div v-if="visible" class="trail ui-panel" role="list" :aria-label="t('selection.title')">
    <ol class="steps">
      <li
        v-for="(node, index) in nodes"
        :key="node.id"
        class="step"
        :class="{ focus: node.id === workspace.state.focusId }"
      >
        <button
          class="chip"
          :title="labelOf(node)"
          @click="workspace.setFocus(node.id)"
          @mousemove="onMove($event, node)"
          @mouseleave="peekHide(node.id)"
        >
          <span class="index">{{ index + 1 }}</span>
          <span class="label">{{ labelOf(node) }}</span>
        </button>
        <button class="drop" :title="t('selection.remove')" @click.stop="remove(node)">
          <NIcon :component="CloseOutline" :size="11" />
        </button>
      </li>
    </ol>
    <button class="clear" :title="t('selection.clear')" @click="workspace.clearSelection()">
      {{ t("selection.clear") }}
    </button>
  </div>
</template>

<style scoped>
.trail {
  display: flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  min-width: 0;
  padding: 3px 4px;
  border-radius: 999px;
}

/* Steps share the available width instead of being clipped: a long trail
 * compresses its labels rather than hiding its tail. */
.steps {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-x: auto;
  scrollbar-width: none;
}

.steps::-webkit-scrollbar {
  display: none;
}

.step {
  display: flex;
  align-items: center;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 240px;
  border-radius: 999px;
}

.step:hover {
  background: var(--refino-surface-raised);
}

.step.focus {
  background: var(--refino-accent-soft);
}

.chip {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 26px;
  padding: 0 2px 0 7px;
  border: none;
  border-radius: 999px 0 0 999px;
  background: transparent;
  color: var(--refino-text-dim);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.step.focus .chip {
  color: var(--refino-primary);
}

.index {
  flex: none;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  opacity: 0.6;
}

.label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drop {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 20px;
  margin-right: 3px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--refino-text-faint);
  cursor: pointer;
  padding: 0;
}

.drop:hover {
  background: var(--refino-surface);
  color: var(--refino-text);
}

/* Clearing is always reachable, outside the shrinking step list. */
.clear {
  flex: none;
  height: 26px;
  padding: 0 10px;
  margin-left: 2px;
  border: none;
  border-left: 1px solid var(--refino-border);
  border-radius: 0 999px 999px 0;
  background: transparent;
  color: var(--refino-text-faint);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.clear:hover {
  background: var(--refino-surface-raised);
  color: var(--refino-text);
}
</style>
