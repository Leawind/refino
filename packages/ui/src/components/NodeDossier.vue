<script setup lang="ts">
// The node dossier: the right-hand read pane for the focused node — the
// one place that answers "what is this node" (ui DESIGN.md, "布局").
// Loads the full record plus its direct dependents on focus, renders the
// body as markdown, and lists grounds/dependents as navigable rows
// ("why" / "what for"). Read-only: editing opens the same pane's editor.
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { NButton, NDropdown, NIcon, NSpin } from "naive-ui";
import {
  AlertCircleOutline,
  ChevronForwardOutline,
  CreateOutline,
  EllipsisHorizontalOutline,
} from "@vicons/ionicons5";
import { clientKey } from "../api";
import { injectRequired } from "../context";
import { fetchGroundLites } from "../grounds";
import { renderMarkdown, renderMermaidDiagrams } from "../markdown";
import { peekHide, peekMove } from "../peek";
import { storeKey } from "../store";
import { nodeOpsKey } from "../nodeOps";
import { workspaceKey } from "../workspace";
import type { IssueRecord, NodeLite, NodeRecord } from "../types";

const client = injectRequired(clientKey, "client");
const workspace = injectRequired(workspaceKey, "workspace");
const store = injectRequired(storeKey, "store");
const nodeOps = injectRequired(nodeOpsKey, "nodeOps");

const { t } = useI18n();

defineEmits<{ collapse: [] }>();

const focusId = computed(() => workspace.state.focusId);
const record = ref<NodeRecord | null>(null);
const grounds = ref<NodeLite[]>([]);
const dependents = ref<NodeLite[]>([]);
const issues = ref<IssueRecord[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

/** Latest-wins guard: focus changes can outpace the fetches. */
let token = 0;

function dependentsOf(groups: Awaited<ReturnType<typeof client.queryNeighbors>>, id: string) {
  return groups
    .flatMap((group) => ("results" in group ? (group.results[0]?.nodes ?? []) : []))
    .filter((node) => node.id !== id);
}

async function load(id: string): Promise<void> {
  const mine = ++token;
  loading.value = true;
  error.value = null;
  try {
    const [detail, groups] = await Promise.all([
      client.fetchNode(id),
      client.queryNeighbors([id], { ancestorDepth: 0, descendantDepth: 1 }),
    ]);
    if (mine !== token) return;
    record.value = detail.node;
    issues.value = detail.issues;
    dependents.value = dependentsOf(groups, id);
    grounds.value =
      detail.node.type === "decision" && (detail.node.grounds?.length ?? 0) > 0
        ? await fetchGroundLites(client, id)
        : [];
  } catch (failure) {
    if (mine !== token) return;
    record.value = null;
    grounds.value = [];
    dependents.value = [];
    issues.value = [];
    error.value = failure instanceof Error ? failure.message : String(failure);
  } finally {
    if (mine === token) loading.value = false;
  }
}

watch(
  focusId,
  (id) => {
    token++;
    if (id === null) {
      record.value = null;
      grounds.value = [];
      dependents.value = [];
      issues.value = [];
      error.value = null;
      return;
    }
    void load(id);
  },
  { immediate: true },
);

// External changes touching the shown node refresh it; its dependents may
// have changed too, so both ride the same reload.
const off = workspace.onChange((event) => {
  const id = focusId.value;
  if (id === null) return;
  if (event.deleted.includes(id)) {
    token++;
    record.value = null;
    grounds.value = [];
    dependents.value = [];
    issues.value = [];
    error.value = t("dossier.deleted");
    return;
  }
  if (event.reload === true || event.changed.includes(id)) void load(id);
});
onBeforeUnmount(off);

const title = computed(() => {
  const summary = record.value?.summary.trim() ?? "";
  return summary === "" ? t("node.untitled") : summary;
});

const renderedBody = computed(() => renderMarkdown(record.value?.body ?? ""));
const rationale = computed(() => record.value?.rationale?.trim() ?? "");

/** Render mermaid diagrams once the markdown is on the page, and again on a
 * theme flip (mermaid carries its own palettes). */
const bodyEl = ref<HTMLElement | null>(null);
watch(
  [renderedBody, () => store.state.theme],
  () => {
    void nextTick(async () => {
      if (bodyEl.value !== null) await renderMermaidDiagrams(bodyEl.value, store.state.theme);
    });
  },
  { immediate: true },
);

const confirmed = computed(() => {
  const value = record.value?.confirmed;
  if (value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
});

const moreOptions = computed(() => [
  { label: t("canvas.refineThis"), key: "refine" },
  { type: "divider" as const, key: "divider" },
  { label: t("node.delete"), key: "delete" },
]);

function onMore(key: string): void {
  const id = record.value?.id;
  if (id === undefined) return;
  if (key === "refine") store.startCreate("decision", { grounds: [id] });
  else if (key === "delete") void nodeOps.deleteNode(id);
}

function locate(id: string): void {
  workspace.locate(id);
}

function onRowMove(event: MouseEvent, id: string): void {
  peekMove(id, event.clientX, event.clientY);
}
</script>

<template>
  <div class="dossier">
    <header class="head">
      <span class="eyebrow">{{ t("dossier.title") }}</span>
      <span class="spacer" />
      <template v-if="record !== null">
        <NButton size="tiny" secondary @click="store.openEditor(record.id)">
          <template #icon>
            <NIcon :component="CreateOutline" />
          </template>
          {{ t("node.edit") }}
        </NButton>
        <NDropdown trigger="click" placement="bottom-end" :options="moreOptions" @select="onMore">
          <button class="ui-icon-btn" :title="t('dossier.more')">
            <NIcon :component="EllipsisHorizontalOutline" />
          </button>
        </NDropdown>
      </template>
      <button class="ui-icon-btn" :title="t('dossier.collapse')" @click="$emit('collapse')">
        <NIcon :component="ChevronForwardOutline" />
      </button>
    </header>

    <div v-if="focusId === null" class="empty">
      <p class="empty-title">{{ t("dossier.emptyTitle") }}</p>
      <p class="empty-hint">{{ t("dossier.emptyHint") }}</p>
      <ul class="keys">
        <li>
          <kbd>Ctrl</kbd><kbd>K</kbd><span>{{ t("palette.title") }}</span>
        </li>
        <li>
          <kbd>Alt</kbd><span>{{ t("dossier.peekHint") }}</span>
        </li>
        <li>
          <kbd>E</kbd><span>{{ t("dossier.editHint") }}</span>
        </li>
        <li>
          <kbd>Esc</kbd><span>{{ t("dossier.escHint") }}</span>
        </li>
      </ul>
    </div>

    <div v-else-if="loading && record === null" class="loading">
      <NSpin size="small" />
    </div>

    <div v-else-if="error !== null" class="empty">
      <p class="empty-hint error">{{ error }}</p>
    </div>

    <article v-else-if="record !== null" class="body">
      <div class="tags">
        <span class="kind" :class="record.type">
          {{ t(`node.${record.type}`) }}
        </span>
        <span v-if="record.exploring === true" class="kind trial">{{ t("node.exploring") }}</span>
        <span v-if="confirmed !== null" class="meta"
          >{{ t("node.confirmed") }} {{ confirmed }}</span
        >
      </div>

      <h1 class="summary" :class="{ untitled: record.summary.trim() === '' }">{{ title }}</h1>

      <div v-if="issues.length > 0" class="issues">
        <p class="issues-head">
          <NIcon :component="AlertCircleOutline" :size="14" />
          {{ t("status.issues") }}
        </p>
        <p v-for="issue in issues" :key="issue.message" class="issue">{{ issue.message }}</p>
      </div>

      <div ref="bodyEl" class="prose" v-html="renderedBody" />
      <p v-if="record.body.trim() === ''" class="placeholder">{{ t("dossier.noBody") }}</p>

      <section v-if="rationale !== ''" class="section">
        <h2>{{ t("dossier.rationale") }}</h2>
        <p class="rationale">{{ rationale }}</p>
      </section>

      <section v-if="record.type === 'decision'" class="section">
        <h2>
          {{ t("node.grounds") }}
          <span class="count">{{ grounds.length }}</span>
        </h2>
        <ul v-if="grounds.length > 0" class="links">
          <li v-for="ground in grounds" :key="ground.id">
            <button
              class="link"
              @click="locate(ground.id)"
              @mousemove="onRowMove($event, ground.id)"
              @mouseleave="peekHide(ground.id)"
            >
              <span class="glyph" :class="ground.type" />
              <span class="label">{{
                ground.summary === "" ? t("node.untitled") : ground.summary
              }}</span>
            </button>
          </li>
        </ul>
        <p v-else class="placeholder">{{ t("dossier.noGrounds") }}</p>
      </section>

      <section class="section">
        <h2>
          {{ t("node.dependents") }}
          <span class="count">{{ dependents.length }}</span>
        </h2>
        <ul v-if="dependents.length > 0" class="links">
          <li v-for="node in dependents" :key="node.id">
            <button
              class="link"
              @click="locate(node.id)"
              @mousemove="onRowMove($event, node.id)"
              @mouseleave="peekHide(node.id)"
            >
              <span class="glyph" :class="node.type" />
              <span class="label">{{
                node.summary === "" ? t("node.untitled") : node.summary
              }}</span>
            </button>
          </li>
        </ul>
        <p v-else class="placeholder">{{ t("dossier.noDependents") }}</p>
      </section>

      <p class="foot">
        <span class="mono">{{ record.id }}</span>
      </p>
    </article>
  </div>
</template>

<style scoped>
.dossier {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--refino-surface);
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 44px;
  padding: 0 8px 0 16px;
  border-bottom: 1px solid var(--refino-border);
}

.eyebrow {
  font-size: 12px;
  font-weight: 600;
  color: var(--refino-text-dim);
}

.spacer {
  flex: 1;
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px 24px;
}

.tags {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 20px;
}

.kind {
  font-size: 11px;
  line-height: 1;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--refino-surface-raised);
  color: var(--refino-text-dim);
}

.kind.decision {
  background: var(--refino-accent-soft);
  color: var(--refino-primary);
}

.kind.trial {
  background: var(--refino-warn-soft);
  color: var(--refino-warn);
}

.meta {
  margin-left: auto;
  font-size: 11px;
  color: var(--refino-text-faint);
  white-space: nowrap;
}

.summary {
  margin: 10px 0 14px;
  font-size: 17px;
  line-height: 1.45;
  font-weight: 600;
  letter-spacing: 0.01em;
  overflow-wrap: anywhere;
}

.summary.untitled {
  color: var(--refino-text-faint);
  font-style: italic;
  font-weight: 500;
}

.prose {
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.prose :deep(p) {
  margin: 0 0 10px;
}

.prose :deep(h1),
.prose :deep(h2),
.prose :deep(h3) {
  font-size: 14px;
  margin: 16px 0 8px;
}

.prose :deep(ul),
.prose :deep(ol) {
  padding-left: 20px;
  margin: 0 0 10px;
}

.prose :deep(code) {
  font-family: var(--refino-font-mono);
  font-size: 12px;
  background: var(--refino-surface-raised);
  padding: 1px 4px;
  border-radius: 4px;
}

.prose :deep(pre) {
  background: var(--refino-surface-raised);
  padding: 10px 12px;
  border-radius: var(--refino-radius);
  overflow-x: auto;
}

.prose :deep(pre code) {
  background: transparent;
  padding: 0;
}

.prose :deep(blockquote) {
  margin: 0 0 10px;
  padding-left: 12px;
  border-left: 2px solid var(--refino-border-strong);
  color: var(--refino-text-dim);
}

.prose :deep(table) {
  border-collapse: collapse;
  font-size: 12px;
}

.prose :deep(th),
.prose :deep(td) {
  border: 1px solid var(--refino-border);
  padding: 4px 8px;
}

.prose :deep(img) {
  max-width: 100%;
}

.section {
  margin-top: 22px;
}

.section h2 {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--refino-text-dim);
}

.count {
  font-variant-numeric: tabular-nums;
  color: var(--refino-text-faint);
  font-weight: 400;
}

.rationale {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--refino-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.links {
  margin: 0;
  padding: 0;
  list-style: none;
}

.link {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  margin: 0 -8px;
  border: none;
  border-radius: var(--refino-radius-sm);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
}

.link:hover {
  background: var(--refino-surface-raised);
}

.glyph {
  flex: none;
  width: 6px;
  height: 6px;
  margin-top: 7px;
  border-radius: 50%;
  background: var(--refino-text-faint);
}

.glyph.decision {
  border-radius: 1px;
  transform: rotate(45deg);
  background: var(--refino-primary);
}

.label {
  min-width: 0;
  overflow-wrap: anywhere;
}

.placeholder {
  margin: 0;
  font-size: 12px;
  color: var(--refino-text-faint);
}

.issues {
  margin: 0 0 14px;
  padding: 8px 10px;
  border-radius: var(--refino-radius);
  background: var(--refino-danger-soft);
}

.issues-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--refino-danger);
}

.issue {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--refino-danger);
}

.foot {
  margin: 26px 0 0;
  padding-top: 12px;
  border-top: 1px solid var(--refino-border);
  font-size: 11px;
  color: var(--refino-text-faint);
}

.mono {
  font-family: var(--refino-font-mono);
}

.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 24px 24px 80px;
}

.empty-title {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 600;
}

.empty-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--refino-text-dim);
}

.empty-hint.error {
  color: var(--refino-danger);
}

.keys {
  margin: 18px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12px;
  color: var(--refino-text-dim);
}

.keys li {
  display: flex;
  align-items: center;
  gap: 4px;
}

.keys span {
  margin-left: 6px;
}

kbd {
  font-family: var(--refino-font-mono);
  font-size: 11px;
  line-height: 1;
  padding: 3px 5px;
  border: 1px solid var(--refino-border);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--refino-surface);
  color: var(--refino-text-dim);
}

.loading {
  flex: 1;
  display: grid;
  place-items: center;
}
</style>
