<script setup lang="ts">
// Detail bar docked below the decision graph: details of the selected
// node, with edit/create forms. Opens on double click; closing keeps the
// selection. The bar occupies the bottom of the graph pane; expanding
// turns it into a near-fullscreen modal with a dimmed backdrop.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  NButton,
  NIcon,
  NInput,
  NPopconfirm,
  NSelect,
  NSpin,
  NSwitch,
  NTag,
  NTooltip,
  useMessage,
} from "naive-ui";
import { SwapHorizontalOutline } from "@vicons/ionicons5";
import { renderMarkdown, renderMermaidDiagrams } from "../markdown";
import { CloseOutline, ContractOutline, ExpandOutline } from "@vicons/ionicons5";
import FormField from "./FormField.vue";
import { search } from "../api";
import { changedFields, toEditorFields } from "../conflict";
import { recreateDetail, store } from "../store";
import { workspace } from "../workspace";
import type { NodePayload } from "../types";

const { t } = useI18n();
const message = useMessage();

const selected = computed(() => store.state.detail.node);
const creating = computed(() => store.state.creatingType !== null);
const visible = computed(
  () => store.state.detailOpen && (creating.value || store.state.detail.id !== null),
);

const expanded = ref(false);

/** Bar height as a percentage of the graph pane; adjustable by dragging
 * the bar's top edge. */
const MIN_HEIGHT_PERCENT = 15;
const MAX_HEIGHT_PERCENT = 70;
const barEl = ref<HTMLElement | null>(null);
const heightPercent = ref(40);

const barStyle = computed(() =>
  expanded.value ? undefined : { height: `${heightPercent.value}%` },
);

let resizeStartY = 0;
let resizeStartPercent = 0;

function onResizeStart(event: MouseEvent): void {
  resizeStartY = event.clientY;
  resizeStartPercent = heightPercent.value;
  document.addEventListener("mousemove", onResizeMove);
  document.addEventListener("mouseup", onResizeEnd);
}

function onResizeMove(event: MouseEvent): void {
  // Dragging up grows the bar.
  const delta = resizeStartY - event.clientY;
  const base = barEl.value?.parentElement?.clientHeight ?? 1;
  heightPercent.value = Math.min(
    MAX_HEIGHT_PERCENT,
    Math.max(MIN_HEIGHT_PERCENT, resizeStartPercent + (delta / base) * 100),
  );
}

function onResizeEnd(): void {
  document.removeEventListener("mousemove", onResizeMove);
  document.removeEventListener("mouseup", onResizeEnd);
}

onBeforeUnmount(() => onResizeEnd());

function close(): void {
  expanded.value = false;
  // Closing keeps the node selected.
  store.closeDetail();
}

/** Cancel discards unsaved edits; in create mode it hides the bar. */
function cancelEdit(): void {
  if (creating.value) {
    close();
    return;
  }
  store.resetDetailForm();
}

function onKeydown(event: KeyboardEvent): void {
  if (!visible.value || event.key !== "Escape") return;
  // Esc collapses the expanded view first, then hides the bar.
  if (expanded.value) expanded.value = false;
  else close();
}

onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));

// The form lives in the store: external merges update it while the user's
// edits are preserved, and the conflict flow needs it for field comparisons.
const form = store.form;

/**
 * Grounds options come from the paginated search endpoint (README, "编辑功
 * 能": 多选节点，支持搜索); the fetched page replaces the option list while
 * already-selected ids stay labelled.
 */
const groundOptions = ref<Array<{ label: string; value: string }>>([]);
const groundSearching = ref(false);
let groundSearchToken = 0;

function optionLabel(id: string, summary: string): string {
  return `${id} ${summary === "" ? t("node.untitled") : summary}`;
}

async function searchGrounds(q: string): Promise<void> {
  const token = ++groundSearchToken;
  groundSearching.value = true;
  try {
    const page = await search({ q: q.trim(), limit: 50 });
    if (token !== groundSearchToken) return;
    groundOptions.value = page.nodes
      .filter((node) => node.id !== selected.value?.id)
      .map((node) => ({ label: optionLabel(node.id, node.summary), value: node.id }));
  } catch {
    // Keep the previous options on failure.
  } finally {
    if (token === groundSearchToken) groundSearching.value = false;
  }
}

const mergedGroundOptions = computed(() => {
  const options = new Map(groundOptions.value.map((option) => [option.value, option]));
  for (const id of form.grounds) {
    if (!options.has(id)) options.set(id, { label: id, value: id });
  }
  return [...options.values()];
});

// Seed the options when the bar appears.
watch(visible, (shown) => {
  if (shown) void searchGrounds("");
});

const dependentCount = computed(() => store.state.detail.dependents.length);

/** Toggles the content field between markdown source and rendered output. */
const previewBody = ref(false);
const renderedBody = computed(() => renderMarkdown(form.body));

// Render mermaid diagrams after the preview HTML is on the page, and again
// when the theme flips (mermaid has its own light/dark palettes).
const bodyEl = ref<HTMLElement | null>(null);
watch([renderedBody, () => store.state.theme, previewBody] as const, ([, theme, preview]) => {
  if (!preview) return;
  void nextTick(async () => {
    const el = bodyEl.value;
    if (el === null) return;
    await renderMermaidDiagrams(el, theme);
  });
});

/** Convert the node to the other type; fields of the old type are dropped. */
function switchType(): void {
  const node = selected.value;
  if (node === null || creating.value) return;
  const target = node.type === "premise" ? "constraint" : "premise";
  void store.update(node.id, { ...payload(), type: target });
}

/**
 * Save is only meaningful when something actually changed (or when a new
 * node has the required content), so the button stays disabled otherwise.
 */
const dirty = computed(() => {
  const node = selected.value;
  if (node === null) return form.body.trim() !== "";
  return changedFields(toEditorFields(node), form).length > 0;
});

const canSave = computed(() =>
  creating.value ? form.body.trim() !== "" : dirty.value && form.body.trim() !== "",
);

function payload(): NodePayload {
  return {
    body: form.body,
    summary: form.summary.trim() === "" ? undefined : form.summary.trim(),
    rationale: form.rationale.trim() === "" ? undefined : form.rationale.trim(),
    grounds: form.grounds,
    confirmed: form.confirmed.trim() === "" ? undefined : form.confirmed.trim(),
  };
}

async function save(): Promise<void> {
  try {
    if (creating.value && store.state.creatingType !== null) {
      const id = await store.create(store.state.creatingType, payload());
      message.success(`${t("node.save")}: ${id}`);
    } else if (selected.value !== null) {
      // The revision turns the save into an optimistic concurrency check;
      // a 409 makes the store fetch the external change and run the merge
      // flow before the error surfaces here.
      await store.update(selected.value.id, payload(), store.state.detail.revision ?? undefined);
      message.success(t("node.save"));
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}

/** Recreate the externally deleted node from the form under the same id. */
async function recreate(): Promise<void> {
  const node = selected.value;
  if (node === null) return;
  try {
    await recreateDetail(node.type, payload());
    message.success(t("detail.recreated"));
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}

/** Fields the external change collides on, for the conflict message. */
const conflictFieldLabels = computed(() =>
  (store.state.detail.conflict?.fields ?? []).map((field) => t(`node.${field}`)).join("、"),
);

// Silent field-level merges surface as a toast.
watch(
  () => store.state.detail.mergeNotice,
  (count) => {
    if (count > 0) message.info(t("detail.merged"));
  },
);

async function remove(): Promise<void> {
  if (selected.value === null) return;
  try {
    await store.remove(selected.value.id);
    message.success(t("node.delete"));
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}

function nodeLabel(id: string): string {
  const node = store.state.detail.dependents.find((dependent) => dependent.id === id);
  return node === undefined ? id : optionLabel(id, node.summary);
}
</script>

<template>
  <template v-if="visible">
    <div v-if="expanded" class="backdrop" @click="expanded = false" />
    <section ref="barEl" class="detail-bar" :class="{ expanded }" :style="barStyle">
      <div v-if="!expanded" class="resize-handle" @mousedown.prevent="onResizeStart" />
      <div class="window-actions">
        <NButton
          quaternary
          circle
          size="tiny"
          :title="expanded ? t('window.restore') : t('window.expand')"
          @click="expanded = !expanded"
        >
          <NIcon :component="expanded ? ContractOutline : ExpandOutline" />
        </NButton>
        <NButton quaternary circle size="tiny" :title="t('window.close')" @click="close">
          <NIcon :component="CloseOutline" />
        </NButton>
      </div>

      <!-- The head stays pinned above the scrollable body so the title and
           the type-switch control never scroll away. -->
      <div class="window-head">
        <template v-if="creating">
          <h2>
            {{
              t(
                `node.create${store.state.creatingType?.charAt(0).toUpperCase()}${store.state.creatingType?.slice(1)}`,
              )
            }}
          </h2>
        </template>

        <template v-else-if="selected !== null">
          <div class="head">
            <h2 class="mono">{{ selected.id }}</h2>
            <NTag
              size="small"
              :bordered="false"
              :type="selected.type === 'premise' ? 'default' : 'primary'"
            >
              {{ t(`node.${selected.type}`) }}
            </NTag>
            <NTooltip>
              <template #trigger>
                <NPopconfirm @positive-click="switchType">
                  <template #trigger>
                    <NButton quaternary circle size="tiny" :title="t('node.switchType')">
                      <NIcon :component="SwapHorizontalOutline" />
                    </NButton>
                  </template>
                  {{
                    selected.type === "premise"
                      ? t("node.convertConstraint")
                      : t("node.convertPremise")
                  }}
                </NPopconfirm>
              </template>
              {{ t("node.switchType") }}
            </NTooltip>
          </div>
        </template>
      </div>

      <NAlert
        v-if="store.state.detail.deletedWithEdits"
        type="error"
        class="conflict"
        :show-icon="true"
      >
        {{ t("detail.deletedTitle") }}
        <div class="conflict-actions">
          <NButton size="tiny" type="primary" @click="recreate">
            {{ t("detail.recreate") }}
          </NButton>
          <NButton size="tiny" @click="store.discardDeletedWithEdits()">
            {{ t("detail.discard") }}
          </NButton>
        </div>
      </NAlert>
      <NAlert
        v-else-if="store.state.detail.conflict !== null"
        type="warning"
        class="conflict"
        :show-icon="true"
      >
        {{ t("detail.conflictTitle") }}
        <ul class="conflict-fields">
          <li v-for="field in store.state.detail.conflict.fields" :key="field">
            {{ t(`node.${field}`) }}
          </li>
        </ul>
        <div class="conflict-actions">
          <NButton size="tiny" type="primary" @click="store.applyConflictExternal()">
            {{ t("detail.loadExternal") }}
          </NButton>
          <NButton size="tiny" @click="store.keepLocalOverConflict()">
            {{ t("detail.keepMine") }}
          </NButton>
        </div>
      </NAlert>
      <div ref="bodyEl" class="window-body">
        <div v-if="!creating && selected === null" class="loading">
          <NSpin v-if="store.state.detail.error === null" size="small" />
          <span v-else class="load-error">{{ store.state.detail.error }}</span>
        </div>
        <div class="fields" :class="selected?.type ?? store.state.creatingType">
          <FormField
            v-if="(selected?.type ?? store.state.creatingType) === 'premise'"
            class="f-confirmed"
            :label="t('node.confirmed')"
          >
            <NInput v-model:value="form.confirmed" placeholder="RFC 3339" />
          </FormField>

          <FormField class="f-summary" :label="t('node.summary')">
            <NInput v-model:value="form.summary" :placeholder="t('node.summaryPlaceholder')" />
          </FormField>

          <FormField
            v-if="(selected?.type ?? store.state.creatingType) === 'constraint'"
            class="f-grounds"
            :label="t('node.grounds')"
          >
            <NSelect
              v-model:value="form.grounds"
              multiple
              filterable
              clearable
              remote
              :loading="groundSearching"
              :options="mergedGroundOptions"
              :placeholder="t('node.groundsPlaceholder')"
              @search="searchGrounds"
            />
          </FormField>

          <FormField
            v-if="(selected?.type ?? store.state.creatingType) === 'constraint'"
            class="f-rationale"
            :label="t('node.rationale')"
          >
            <NInput
              v-model:value="form.rationale"
              type="textarea"
              :autosize="{ minRows: 2 }"
              :placeholder="t('node.rationalePlaceholder')"
            />
          </FormField>

          <FormField class="f-body" :label="t('node.body')">
            <template #extra>
              <span class="preview-toggle">
                <NSwitch v-model:value="previewBody" size="small" @click.stop />
                <span @click.stop="previewBody = !previewBody">{{ t("node.preview") }}</span>
              </span>
            </template>
            <!-- Rendered locally from the user-authored markdown source. -->
            <div v-if="previewBody" class="markdown" v-html="renderedBody" />
            <NInput
              v-else
              v-model:value="form.body"
              type="textarea"
              :autosize="{ minRows: 4 }"
              :placeholder="t('node.bodyPlaceholder')"
            />
          </FormField>
        </div>

        <template v-if="!creating && selected !== null && expanded">
          <!-- Dependents are derived from the graph, not stored attributes:
               only surfaced in the expanded view. -->
          <section class="meta">
            <h3>{{ t("node.dependents") }}</h3>
            <template v-if="store.state.detail.dependents.length === 0">—</template>
            <ul v-else class="links">
              <li v-for="dependent in store.state.detail.dependents" :key="dependent.id">
                <a @click="workspace.select(dependent)">{{ nodeLabel(dependent.id) }}</a>
              </li>
            </ul>
          </section>
        </template>
      </div>

      <div class="window-footer">
        <template v-if="!creating && selected !== null">
          <NTooltip :disabled="dependentCount === 0">
            <template #trigger>
              <NPopconfirm @positive-click="remove">
                <template #trigger>
                  <NButton size="small" type="error" ghost :disabled="dependentCount > 0">
                    {{ t("node.delete") }}
                  </NButton>
                </template>
                {{ t("node.deleteConfirm", { id: selected.id }) }}
              </NPopconfirm>
            </template>
            {{ t("node.deleteBlocked", { count: dependentCount }) }}
          </NTooltip>
        </template>
        <span class="spacer" />
        <NButton size="small" @click="cancelEdit">{{ t("node.cancel") }}</NButton>
        <NButton size="small" type="primary" :disabled="!canSave" @click="save">
          {{ t("node.save") }}
        </NButton>
      </div>
    </section>
  </template>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
  z-index: 55;
}

.detail-bar {
  position: relative;
  flex: none;
  min-height: 120px;
  display: flex;
  flex-direction: column;
  background: var(--refino-surface);
  border-top: 1px solid var(--refino-border);
  box-sizing: border-box;
  z-index: 5;
}

.detail-bar.expanded {
  position: fixed;
  inset: 12px;
  height: auto;
  min-height: 0;
  border: 1px solid var(--refino-border);
  border-radius: var(--refino-radius);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
  z-index: 60;
  overflow: hidden;
}

.resize-handle {
  position: absolute;
  top: -3px;
  left: 0;
  right: 0;
  height: 6px;
  cursor: row-resize;
  z-index: 3;
}

.resize-handle:hover {
  background: rgba(24, 160, 88, 0.25);
}

.window-actions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 4px;
  z-index: 2;
}

.window-actions .n-button {
  font-size: 12px;
}

.window-head {
  flex: none;
  padding: 12px 14px 0;
  box-sizing: border-box;
}

.window-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
  box-sizing: border-box;
  container-type: inline-size;
}

.window-footer {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-top: 1px solid var(--refino-border);
}

.window-footer .spacer {
  flex: 1;
}

/* Wide bars: grounds/rationale in the left column, summary+body on the
 * right so the long content stays last. */
@container (min-width: 640px) {
  .fields.constraint {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
    column-gap: 16px;
  }

  .fields.constraint .f-summary,
  .fields.constraint .f-body {
    grid-column: 2;
  }

  .fields.constraint .f-grounds,
  .fields.constraint .f-rationale {
    grid-column: 1;
  }

  .fields.constraint .f-summary {
    grid-row: 1;
  }

  .fields.constraint .f-grounds {
    grid-row: 1;
  }

  .fields.constraint .f-rationale {
    grid-row: 2;
  }

  .fields.constraint .f-body {
    grid-row: 2 / span 2;
  }
}

.fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  row-gap: 14px;
}

.loading {
  display: grid;
  place-items: center;
  padding: 8px 0 14px;
}

.conflict {
  margin: 0 0 12px;
}

.conflict-fields {
  margin: 6px 0;
  padding-left: 18px;
}

.conflict-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.loading .load-error {
  color: #d03050;
  font-size: 12px;
}

.fields .f-body {
  grid-row: auto;
}

.label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.preview-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
}

.markdown {
  font-size: 13px;
  width: 100%;
  box-sizing: border-box;
  /* Mirror the textarea frame so switching to preview keeps the field
   * outline visible. */
  border: 1px solid var(--refino-border);
  border-radius: var(--refino-radius);
  padding: 6px 10px;
  min-height: 60px;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

h2 {
  font-size: 15px;
  margin: 0 0 8px;
}

.mono {
  font-family: monospace;
}

.actions {
  display: flex;
  gap: 8px;
}

.meta {
  margin: 12px 0 0;
  font-size: 12px;
}

.meta dt {
  opacity: 0.6;
  margin-top: 8px;
}

.meta dd {
  margin: 2px 0 0;
}

.links {
  margin: 0;
  padding: 0;
  list-style: none;
}

.links a {
  cursor: pointer;
  color: var(--refino-primary, #18a058);
}

.meta h3 {
  font-size: 12px;
  opacity: 0.6;
  margin: 16px 0 4px;
}
</style>
