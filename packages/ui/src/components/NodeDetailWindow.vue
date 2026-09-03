<script setup lang="ts">
// Floating detail window over the interface: details of the selected node,
// with edit/create forms. Opens on double click; closing keeps the
// selection. The window lives inside the positioned workbench, so both
// states are plain absolute insets — centered dialog by default, covering
// the whole interface when expanded — and the switch animates via CSS.
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  NButton,
  NForm,
  NFormItem,
  NInput,
  NPopconfirm,
  NSelect,
  NTag,
  NTooltip,
  useMessage,
} from "naive-ui";
import { NIcon } from "naive-ui";
import { CloseOutline, ContractOutline, ExpandOutline } from "@vicons/ionicons5";
import { store } from "../store";
import type { NodePayload } from "../types";

const { t } = useI18n();
const message = useMessage();

const selected = computed(() => store.selected);
const creating = computed(() => store.state.creatingType !== null);
const visible = computed(
  () => store.state.detailOpen && (creating.value || selected.value !== null),
);

const expanded = ref(false);

function close(): void {
  expanded.value = false;
  // Closing keeps the node selected.
  store.closeDetail();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && visible.value) close();
}

onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));

interface FormState {
  summary: string;
  body: string;
  rationale: string;
  grounds: string[];
  confirmed: string;
}

const form = reactive<FormState>({
  summary: "",
  body: "",
  rationale: "",
  grounds: [],
  confirmed: "",
});

watch(
  () => [store.state.selectedId, store.state.creatingType] as const,
  () => resetForm(),
  { immediate: true },
);

// Keep the form in sync when the node is reloaded after a save elsewhere.
watch(
  () => selected.value?.body,
  () => {
    if (!creating.value) resetForm();
  },
);

function resetForm(): void {
  const node = selected.value;
  form.summary = node?.summary ?? "";
  form.body = node?.body ?? "";
  form.rationale = node?.rationale ?? "";
  form.grounds = [...(node?.grounds ?? [])];
  form.confirmed = node?.confirmed ?? "";
}

const groundOptions = computed(() =>
  store.state.nodes
    .filter((n) => n.id !== selected.value?.id)
    .map((n) => ({ label: `${n.id} ${n.summary}`, value: n.id })),
);

const dependentCount = computed(() => selected.value?.dependents.length ?? 0);

/**
 * Save is only meaningful when something actually changed (or when a new
 * node has the required content), so the button stays disabled otherwise.
 */
const dirty = computed(() => {
  const node = selected.value;
  if (node === null) return form.body.trim() !== "";
  return (
    form.summary !== node.summary ||
    form.body !== node.body ||
    form.rationale !== (node.rationale ?? "") ||
    JSON.stringify(form.grounds) !== JSON.stringify(node.grounds ?? []) ||
    form.confirmed !== (node.confirmed ?? "")
  );
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
      await store.update(selected.value.id, payload());
      message.success(t("node.save"));
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}

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
  const node = store.state.nodes.find((n) => n.id === id);
  return node === undefined ? id : `${id} ${node.summary}`;
}
</script>

<template>
  <template v-if="visible">
    <div class="backdrop" @click="close" />
    <section class="window" :class="{ expanded }" @click.stop>
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

      <div class="window-body">
        <template v-if="creating">
          <h2>
            {{
              t(
                `node.create${store.state.creatingType?.charAt(0).toUpperCase()}${store.state.creatingType?.slice(1)}`,
              )
            }}
          </h2>
          <NForm label-placement="top" size="small">
            <NFormItem :label="t('node.body')">
              <NInput
                v-model:value="form.body"
                type="textarea"
                :autosize="{ minRows: 4 }"
                :placeholder="t('node.bodyPlaceholder')"
              />
            </NFormItem>
            <NFormItem :label="t('node.summary')">
              <NInput v-model:value="form.summary" :placeholder="t('node.summaryPlaceholder')" />
            </NFormItem>
            <template v-if="store.state.creatingType === 'constraint'">
              <NFormItem :label="t('node.grounds')">
                <NSelect
                  v-model:value="form.grounds"
                  multiple
                  filterable
                  clearable
                  :options="groundOptions"
                  :placeholder="t('node.groundsPlaceholder')"
                />
              </NFormItem>
              <NFormItem :label="t('node.rationale')">
                <NInput
                  v-model:value="form.rationale"
                  type="textarea"
                  :autosize="{ minRows: 2 }"
                  :placeholder="t('node.rationalePlaceholder')"
                />
              </NFormItem>
            </template>
            <div class="actions">
              <NButton size="small" type="primary" :disabled="!canSave" @click="save">
                {{ t("node.save") }}
              </NButton>
              <NButton size="small" @click="close">{{ t("node.cancel") }}</NButton>
            </div>
          </NForm>
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

          <NForm label-placement="top" size="small">
            <NFormItem :label="t('node.summary')">
              <NInput v-model:value="form.summary" :placeholder="t('node.summaryPlaceholder')" />
            </NFormItem>
            <NFormItem :label="t('node.body')">
              <NInput
                v-model:value="form.body"
                type="textarea"
                :autosize="{ minRows: 4 }"
                :placeholder="t('node.bodyPlaceholder')"
              />
            </NFormItem>
            <template v-if="selected.type === 'constraint'">
              <NFormItem :label="t('node.grounds')">
                <NSelect
                  v-model:value="form.grounds"
                  multiple
                  filterable
                  clearable
                  :options="groundOptions"
                  :placeholder="t('node.groundsPlaceholder')"
                />
              </NFormItem>
              <NFormItem :label="t('node.rationale')">
                <NInput
                  v-model:value="form.rationale"
                  type="textarea"
                  :autosize="{ minRows: 2 }"
                  :placeholder="t('node.rationalePlaceholder')"
                />
              </NFormItem>
            </template>
            <NFormItem v-if="selected.type === 'premise'" :label="t('node.confirmed')">
              <NInput v-model:value="form.confirmed" placeholder="RFC 3339" />
            </NFormItem>
            <div class="actions">
              <NButton size="small" type="primary" :disabled="!canSave" @click="save">
                {{ t("node.save") }}
              </NButton>
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
            </div>
          </NForm>

          <!-- Dependents are derived from the graph, not stored attributes:
               only surfaced in the expanded view. -->
          <section v-if="expanded" class="meta">
            <h3>{{ t("node.dependents") }}</h3>
            <template v-if="selected.dependents.length === 0">—</template>
            <ul v-else class="links">
              <li v-for="id in selected.dependents" :key="id">
                <a @click="store.select(id)">{{ nodeLabel(id) }}</a>
              </li>
            </ul>
          </section>
        </template>
      </div>
    </section>
  </template>
</template>

<style scoped>
.backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
  z-index: 40;
}

.window {
  position: absolute;
  /* Centered dialog by default; expanded covers the whole interface. Both
   * are plain insets inside the workbench, so the switch just animates. */
  top: 24px;
  bottom: 24px;
  left: 0;
  right: 0;
  margin-inline: auto;
  width: min(62rem, calc(100% - 48px));
  transition:
    inset 0.25s ease,
    width 0.25s ease;
  display: flex;
  flex-direction: column;
  background: var(--refino-surface);
  border: 1px solid var(--refino-border);
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
  z-index: 41;
  overflow: hidden;
}

.window.expanded {
  inset: 12px;
  width: auto;
  z-index: 41;
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

.window-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
  box-sizing: border-box;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
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
