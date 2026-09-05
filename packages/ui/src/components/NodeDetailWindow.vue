<script setup lang="ts">
// Full editor modal (README, "细节三层模型"): the ground for creation,
// long-form editing, grounds list editing (one row per ground, Alt+hover
// peeking) and conflict/deletion decisions. Opens on double click; closing
// keeps the selection. External changes merge field-by-field per
// docs/design.md, "编辑冲突处理". The inline row editor of the explorer
// shares this component's store session.
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
  NTag,
  NTooltip,
  useMessage,
} from "naive-ui";
import { renderMarkdown, renderMermaidDiagrams } from "../markdown";
import { CloseOutline } from "@vicons/ionicons5";
import FormField from "./FormField.vue";
import GroundsField from "./GroundsField.vue";
import { injectRequired } from "../context";
import { changedFields, toEditorFields } from "../conflict";
import { storeKey } from "../store";
import { workspaceKey } from "../workspace";
import type { NodePayload } from "../types";

const store = injectRequired(storeKey, "store");
const workspace = injectRequired(workspaceKey, "workspace");

const { t } = useI18n();
const message = useMessage();

const selected = computed(() => store.state.detail.node);
const creating = computed(() => store.state.creatingType !== null);
const visible = computed(
  () => store.state.detailOpen && (creating.value || store.state.detail.id !== null),
);

function close(): void {
  // Closing keeps the node selected.
  store.closeDetail();
}

/** Cancel discards unsaved edits; in create mode it hides the modal. */
function cancelEdit(): void {
  if (creating.value) {
    close();
    return;
  }
  store.resetDetailForm();
}

function onKeydown(event: KeyboardEvent): void {
  if (!visible.value || event.key !== "Escape") return;
  close();
  // The app shell's Esc handler (clear selection) also sits on document:
  // this listener registered first (child before parent), so stop the
  // event here or closing the editor would clear the kept selection.
  event.stopImmediatePropagation();
}

onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));

// The form lives in the store: external merges update it while the user's
// edits are preserved, and the conflict flow needs it for field comparisons.
const form = store.form;

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
    await store.recreateDetail(node.type, payload());
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
  // Lists show summaries, not ids; the id stays visible in the head.
  const node = store.state.detail.dependents.find((dependent) => dependent.id === id);
  if (node === undefined) return id;
  return node.summary === "" ? t("node.untitled") : node.summary;
}
</script>

<template>
  <template v-if="visible">
    <div class="backdrop" @click="close" />
    <section class="editor-modal">
      <div class="window-actions">
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
            <!-- One ground per row, shown by summary; rows peek on Alt+hover
                 (GroundsField). -->
            <GroundsField
              v-model:grounds="form.grounds"
              :owner-id="creating ? null : (selected?.id ?? null)"
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

        <template v-if="!creating && selected !== null">
          <!-- Dependents are derived from the graph, not stored attributes. -->
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

.editor-modal {
  position: fixed;
  inset: 12px;
  display: flex;
  flex-direction: column;
  background: var(--refino-surface);
  border: 1px solid var(--refino-border);
  border-radius: var(--refino-radius);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
  z-index: 60;
  overflow: hidden;
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
