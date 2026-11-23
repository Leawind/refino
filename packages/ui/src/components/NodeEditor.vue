<script setup lang="ts">
// The node editor sheet: the right pane's write mode, pinned to one node
// (or one new node). It replaces the former full-screen modal — the canvas
// stays visible while a claim and its grounds are written, and the pinned
// session never switches nodes under the user's edits (ui DESIGN.md, "布局").
// External changes merge per docs/design.md, "编辑冲突处理".
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  NAlert,
  NButton,
  NIcon,
  NInput,
  NPopconfirm,
  NSpin,
  NSwitch,
  NTooltip,
  useMessage,
} from "naive-ui";
import { ArrowBackOutline } from "@vicons/ionicons5";
import FormField from "./FormField.vue";
import GroundsField from "./GroundsField.vue";
import { injectRequired } from "../context";
import { changedFields, toEditorFields } from "../conflict";
import { confirmAction } from "../feedback";
import { renderMarkdown, renderMermaidDiagrams } from "../markdown";
import { storeKey } from "../store";

const store = injectRequired(storeKey, "store");
const { t } = useI18n();
const message = useMessage();

const selected = computed(() => store.state.detail.node);
const creating = computed(() => store.state.creatingType !== null);
const kind = computed(() => selected.value?.type ?? store.state.creatingType);

const form = store.form;

/** Re-render mermaid diagrams after the preview HTML changes or the theme
 * flips; the preview is the only markdown surface here. */
const previewBody = ref(false);
const renderedBody = computed(() => renderMarkdown(form.body));
const bodyEl = ref<HTMLElement | null>(null);
watch([renderedBody, () => store.state.theme, previewBody] as const, ([, theme, preview]) => {
  if (!preview) return;
  void nextTick(async () => {
    if (bodyEl.value !== null) await renderMermaidDiagrams(bodyEl.value, theme);
  });
});

const dirty = computed(() => {
  const node = selected.value;
  if (node === null) return true;
  return changedFields(toEditorFields(node), form).length > 0;
});

const canSave = computed(() => (creating.value ? true : dirty.value));

async function save(): Promise<void> {
  const wasCreating = creating.value;
  try {
    await store.saveCurrent();
    message.success(
      wasCreating
        ? t("node.created", {
            node: form.summary.trim() === "" ? t("node.untitled") : form.summary.trim(),
          })
        : t("node.saved"),
    );
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}

/** Resolve a parked switch request (another node was asked for meanwhile). */
async function resolve(action: "save" | "discard" | "cancel"): Promise<void> {
  try {
    await store.resolvePending(action);
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}

function requestClose(): void {
  if (!store.hasUnsavedWork()) {
    store.closeEditor();
    return;
  }
  confirmAction({
    title: t("editor.discardTitle"),
    content: t("editor.discardContent"),
    positiveText: t("editor.discard"),
    onConfirm: () => store.closeEditor(),
  });
}

function onKeydown(event: KeyboardEvent): void {
  if (!store.state.editorOpen || event.key !== "Escape") return;
  // Esc belongs to the sheet while it is open; the shell's Esc (clear the
  // selection) must not also fire.
  event.stopImmediatePropagation();
  requestClose();
}
onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));

/** Fields the external change collides on, for the conflict message. */
const conflictFieldLabels = computed(() =>
  (store.state.detail.conflict?.fields ?? []).map((field) => t(`node.${field}`)).join("、"),
);

watch(
  () => store.state.detail.mergeNotice,
  (count) => {
    if (count > 0) message.info(t("detail.merged"));
  },
);

const dependentCount = computed(() => store.state.detail.dependents.length);

async function remove(): Promise<void> {
  if (selected.value === null) return;
  try {
    await store.remove(selected.value.id);
    message.success(t("node.delete"));
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}

async function recreate(): Promise<void> {
  const node = selected.value;
  if (node === null) return;
  try {
    await store.recreateDetail(node.type);
    message.success(t("detail.recreated"));
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}
</script>

<template>
  <div class="editor">
    <header class="head">
      <button class="ui-icon-btn" :title="t('editor.back')" @click="requestClose">
        <NIcon :component="ArrowBackOutline" />
      </button>
      <span class="eyebrow">
        <span class="eyebrow-main">
          {{ creating ? t("editor.createTitle") : t("editor.editTitle") }}
          <span v-if="kind !== null" class="kind">{{ t(`node.${kind}`) }}</span>
        </span>
        <!-- The sheet is pinned: name the node even when the canvas focus
             moved on, so the editor never edits something unnamed. -->
        <span v-if="!creating && selected !== null" class="subject">
          {{ form.summary.trim() === "" ? t("node.untitled") : form.summary.trim() }}
        </span>
      </span>
      <span v-if="dirty && !creating" class="dirty" :title="t('inline.dirty')" />
      <span class="spacer" />
      <NButton size="small" type="primary" :disabled="!canSave" @click="save">
        {{ t("node.save") }}
      </NButton>
    </header>

    <div class="scroll">
      <NAlert
        v-if="store.state.pendingEditor !== null"
        type="info"
        class="conflict"
        :bordered="false"
      >
        {{ t("editor.pending") }}
        <div class="conflict-actions">
          <NButton size="tiny" type="primary" @click="resolve('save')">
            {{ t("editor.saveAndSwitch") }}
          </NButton>
          <NButton size="tiny" @click="resolve('discard')">
            {{ t("editor.discardAndSwitch") }}
          </NButton>
          <NButton size="tiny" quaternary @click="resolve('cancel')">
            {{ t("node.cancel") }}
          </NButton>
        </div>
      </NAlert>
      <NAlert
        v-if="store.state.detail.deletedWithEdits"
        type="error"
        class="conflict"
        :bordered="false"
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
        :bordered="false"
      >
        {{ t("detail.conflictTitle") }}
        <span class="conflict-fields">{{ conflictFieldLabels }}</span>
        <div class="conflict-actions">
          <NButton size="tiny" type="primary" @click="store.applyConflictExternal()">
            {{ t("detail.loadExternal") }}
          </NButton>
          <NButton size="tiny" @click="store.keepLocalOverConflict()">
            {{ t("detail.keepMine") }}
          </NButton>
        </div>
      </NAlert>

      <div v-if="!creating && selected === null" class="loading">
        <NSpin v-if="store.state.detail.error === null" size="small" />
        <span v-else class="error">{{ store.state.detail.error }}</span>
      </div>

      <div v-else ref="bodyEl" class="fields">
        <FormField class="f-summary" :label="t('node.summary')">
          <NInput v-model:value="form.summary" :placeholder="t('node.summaryPlaceholder')" />
        </FormField>

        <FormField v-if="kind === 'premise'" :label="t('node.confirmed')">
          <NInput v-model:value="form.confirmed" placeholder="RFC 3339" />
        </FormField>

        <FormField v-if="kind === 'decision'" :label="t('node.grounds')">
          <!-- One ground per row, shown by summary; rows peek on Alt+hover. -->
          <GroundsField
            v-model:grounds="form.grounds"
            :owner-id="creating ? null : (selected?.id ?? null)"
          />
        </FormField>

        <FormField v-if="kind === 'decision'" :label="t('node.rationale')">
          <NInput
            v-model:value="form.rationale"
            type="textarea"
            :autosize="{ minRows: 2 }"
            :placeholder="t('node.rationalePlaceholder')"
          />
        </FormField>

        <FormField v-if="kind === 'decision'" :label="t('node.exploring')">
          <div class="exploring-row">
            <NSwitch v-model:value="form.exploring" size="small" />
            <span class="exploring-hint">{{ t("node.exploringNote") }}</span>
          </div>
        </FormField>

        <FormField class="f-body" :label="t('node.body')">
          <template #extra>
            <span class="preview-toggle">
              <NSwitch v-model:value="previewBody" size="small" @click.stop />
              <span @click.stop="previewBody = !previewBody">{{ t("node.preview") }}</span>
            </span>
          </template>
          <div v-if="previewBody" class="markdown" v-html="renderedBody" />
          <NInput
            v-else
            v-model:value="form.body"
            type="textarea"
            :autosize="{ minRows: 6 }"
            :placeholder="t('node.bodyPlaceholder')"
          />
        </FormField>

        <div v-if="!creating && selected !== null" class="tail">
          <NButton size="tiny" quaternary @click="store.resetDetailForm()">
            {{ t("editor.reset") }}
          </NButton>
          <span class="spacer" />
          <NTooltip :disabled="dependentCount === 0">
            <template #trigger>
              <NPopconfirm @positive-click="remove">
                <template #trigger>
                  <NButton size="tiny" quaternary type="error" :disabled="dependentCount > 0">
                    {{ t("node.delete") }}
                  </NButton>
                </template>
                {{
                  t("node.deleteConfirm", {
                    node: form.summary.trim() === "" ? t("node.untitled") : form.summary.trim(),
                  })
                }}
              </NPopconfirm>
            </template>
            {{ t("node.deleteBlocked", { count: dependentCount }) }}
          </NTooltip>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor {
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
  gap: 8px;
  height: 44px;
  padding: 0 10px;
  border-bottom: 1px solid var(--refino-border);
}

.eyebrow {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  font-size: 12px;
  line-height: 1.25;
}

.eyebrow-main {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-weight: 600;
  color: var(--refino-text-dim);
}

.eyebrow-main .kind {
  font-weight: 400;
  color: var(--refino-text-faint);
}

.subject {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--refino-text-faint);
}

.dirty {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--refino-warn);
}

.spacer {
  flex: 1;
}

.scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px 28px;
}

.fields {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.conflict {
  margin: 0 0 14px;
}

.conflict-fields {
  margin-left: 4px;
  font-weight: 600;
}

.conflict-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.loading {
  display: grid;
  place-items: center;
  padding: 40px 0;
}

.error {
  color: var(--refino-danger);
  font-size: 12px;
}

.exploring-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
}

.exploring-hint {
  font-size: 11px;
  line-height: 1.5;
  color: var(--refino-text-faint);
}

.preview-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--refino-text-dim);
  cursor: pointer;
}

.markdown {
  font-size: 13px;
  line-height: 1.7;
  min-height: 120px;
  padding: 8px 10px;
  border: 1px solid var(--refino-border);
  border-radius: var(--refino-radius);
  overflow-wrap: anywhere;
}

.markdown :deep(p) {
  margin: 0 0 10px;
}

.markdown :deep(code) {
  font-family: var(--refino-font-mono);
  font-size: 12px;
}

.markdown :deep(pre) {
  background: var(--refino-surface-raised);
  padding: 10px 12px;
  border-radius: var(--refino-radius);
  overflow-x: auto;
}

.tail {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--refino-border);
}
</style>
