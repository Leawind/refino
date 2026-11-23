<script setup lang="ts">
// Canvas status line: the few facts about the map that the map itself does
// not show — decision count, truncation and render-budget warnings, the
// validation issues, the change-feed state. Quiet by design: it sits at the
// bottom-left edge and never asks for attention (ui DESIGN.md, "布局").
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { NButton, NIcon, NPopover } from "naive-ui";
import { HelpCircleOutline } from "@vicons/ionicons5";
import { injectRequired } from "../context";
import { toggleHelp } from "../help";
import { useMenuEscape } from "../menuEscape";
import { renderCulled } from "../renderStatus";
import { workspaceKey } from "../workspace";

const { t } = useI18n();
const workspace = injectRequired(workspaceKey, "workspace");

const decisionCount = computed(
  () => workspace.displayed.value.filter((node) => node.type === "decision").length,
);

/** List surfaces name nodes by summary; a raw id is only the last resort for
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
  <div class="status">
    <span class="count">{{ decisionCount }} {{ t("status.decisions") }}</span>
    <span v-if="workspace.state.truncated" class="warn">
      {{ t("canvas.truncated") }}
    </span>
    <span v-if="renderCulled" class="warn">{{ t("canvas.renderCulled") }}</span>
    <NPopover
      v-if="workspace.state.issues.length > 0"
      v-model:show="issuesOpen"
      trigger="click"
      placement="top-start"
      :show-arrow="false"
      raw
    >
      <template #trigger>
        <button class="issue-trigger" :title="t('status.issues')">
          {{ workspace.state.issues.length }} {{ t("status.issues") }}
        </button>
      </template>
      <div class="issue-panel ui-panel">
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
    <span
      class="link"
      :class="{ off: !workspace.state.connected }"
      :title="workspace.state.connected ? t('status.live') : t('status.offline')"
    />
    <button class="help" :title="t('app.shortcuts')" @click="toggleHelp">
      <NIcon :component="HelpCircleOutline" :size="13" />
    </button>
  </div>
</template>

<style scoped>
.status {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 24px;
  padding: 0 9px;
  font-size: 11px;
  color: var(--refino-text-dim);
  border-radius: var(--refino-radius-sm);
  background: var(--refino-control-bg);
  border: 1px solid var(--refino-border);
  box-shadow: var(--refino-shadow-1);
  font-variant-numeric: tabular-nums;
  user-select: none;
}

.warn {
  color: var(--refino-warn);
}

/* The issue count is a popover trigger styled like the surrounding text. */
.issue-trigger {
  border: none;
  background: transparent;
  color: var(--refino-danger);
  font: inherit;
  padding: 0;
  cursor: pointer;
}

.issue-trigger:hover {
  text-decoration: underline;
}

/* Change-feed dot: green while the SSE stream is open. */
.link {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--refino-primary);
}

.link.off {
  background: var(--refino-text-faint);
}

.help {
  display: inline-flex;
  align-items: center;
  border: none;
  background: transparent;
  color: inherit;
  padding: 0;
  cursor: pointer;
  opacity: 0.7;
}

.help:hover {
  opacity: 1;
  color: var(--refino-text);
}

.mono {
  font-family: var(--refino-font-mono);
}

.issue-panel {
  max-width: 420px;
  max-height: 50vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  font-size: 12px;
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
  color: var(--refino-text-dim);
}

.issue-message {
  color: var(--refino-danger);
}
</style>
