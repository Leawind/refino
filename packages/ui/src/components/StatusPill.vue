<script setup lang="ts">
// Status pill: canvas statistics and warnings (truncation, render culling,
// issue count, current focus). Sits in the bottom-left float corner. The
// issue count expands a problem list whose entries locate their node on the
// canvas (ui DESIGN.md, "布局"); everything else stays read-only.
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { NButton, NPopover } from "naive-ui";
import { injectRequired } from "../context";
import { useMenuEscape } from "../menuEscape";
import { renderCulled } from "../renderStatus";
import { workspaceKey } from "../workspace";

const { t } = useI18n();

const workspace = injectRequired(workspaceKey, "workspace");

const decisionCount = computed(
  () => workspace.displayed.value.filter((n) => n.type === "decision").length,
);

/** The focus is the last selection entry; present it by summary like every
 * other list surface (ui DESIGN.md, "显示规则与样式" keeps ids out of them). */
const focusLabel = computed(() => {
  const node = workspace.selectedNodes.value.find(
    (candidate) => candidate.id === workspace.state.focusId,
  );
  if (node === undefined) return null;
  return node.summary === "" ? t("node.untitled") : node.summary;
});

/** List surfaces name nodes by summary; a raw id is only a last resort for
 * nodes the working set has never seen. */
function labelOf(id: string): string {
  const node = workspace.displayed.value.find((candidate) => candidate.id === id);
  return node === undefined || node.summary === "" ? id : node.summary;
}

/** Issues grouped by their node so one row reads as one problem site;
 * only the rendered strings are kept (the state's issue shape is a deep
 * readonly view). */
const issueRows = computed(() => {
  const rows: Array<{
    node: string | null;
    label: string | null;
    unknown: boolean;
    messages: string[];
  }> = [];
  const byNode = new Map<string, string[]>();
  const loose: string[] = [];
  for (const issue of workspace.state.issues) {
    if (issue.nodeId === undefined) {
      loose.push(issue.message);
      continue;
    }
    const group = byNode.get(issue.nodeId);
    if (group === undefined) byNode.set(issue.nodeId, [issue.message]);
    else group.push(issue.message);
  }
  for (const [node, messages] of byNode) {
    const label = labelOf(node);
    rows.push({ node, label, unknown: label === node, messages });
  }
  if (loose.length > 0) rows.push({ node: null, label: null, unknown: false, messages: loose });
  return rows;
});

const issuesOpen = ref(false);
useMenuEscape(issuesOpen);

function locate(id: string): void {
  workspace.locate(id);
  // The panel floats over the canvas; clear it so the located node is visible.
  issuesOpen.value = false;
}
</script>

<template>
  <div class="status-pill">
    <span>{{ t("status.decisions") }}: {{ decisionCount }}</span>
    <span v-if="workspace.state.truncated" class="issues">
      {{ t("canvas.truncated") }}
    </span>
    <span v-if="renderCulled" class="issues">
      {{ t("canvas.renderCulled") }}
    </span>
    <NPopover
      v-if="workspace.state.issues.length > 0"
      v-model:show="issuesOpen"
      trigger="click"
      placement="top-start"
      :show-arrow="false"
      raw
      class="issue-popover"
    >
      <template #trigger>
        <button class="issues issue-trigger" :title="t('status.issues')">
          {{ t("status.issues") }}: {{ workspace.state.issues.length }}
        </button>
      </template>
      <div class="issue-panel">
        <div v-for="row in issueRows" :key="row.node ?? row.messages[0]" class="issue-row">
          <div class="issue-texts">
            <span v-if="row.node !== null" class="issue-node" :class="{ mono: row.unknown }">
              {{ row.label }}
            </span>
            <span v-for="message in row.messages" :key="message" class="issue-message">
              {{ message }}
            </span>
          </div>
          <NButton v-if="row.node !== null" size="tiny" quaternary @click="locate(row.node)">
            {{ t("status.locate") }}
          </NButton>
        </div>
      </div>
    </NPopover>
    <span v-if="focusLabel !== null" class="focus" :title="focusLabel">
      {{ t("status.selected") }}: {{ focusLabel }}
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
}

.status-pill .issues {
  color: #d03050;
}

/* The issue count is a popover trigger styled like the surrounding text. */
.issue-trigger {
  border: none;
  background: transparent;
  color: #d03050;
  font: inherit;
  padding: 0;
  cursor: pointer;
}

.issue-trigger:hover {
  text-decoration: underline;
}

.mono {
  font-family: monospace;
}

/* Focus summaries can be long; the pill keeps its footprint by truncating
 * instead of widening across the canvas. */
.focus {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Raw popover: the panel carries its own surface styling. */
.issue-panel {
  max-width: 420px;
  max-height: 50vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  font-size: 12px;
  background: var(--refino-surface);
  border: 1px solid var(--refino-border);
  border-radius: var(--refino-radius);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
}

.issue-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.issue-texts {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.issue-node {
  opacity: 0.6;
}

.issue-message {
  color: #d03050;
}
</style>
