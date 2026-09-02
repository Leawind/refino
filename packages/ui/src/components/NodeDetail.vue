<script setup lang="ts">
// Right panel: details of the selected node, with edit/create forms.
import { computed, reactive, watch } from "vue";
import { useI18n } from "vue-i18n";
import { marked } from "marked";
import {
  NButton,
  NEmpty,
  NForm,
  NFormItem,
  NInput,
  NPopconfirm,
  NSelect,
  NTag,
  NTooltip,
  useMessage,
} from "naive-ui";
import { store } from "../store";
import type { NodePayload } from "../types";

const { t } = useI18n();
const message = useMessage();

const selected = computed(() => store.selected);
const creating = computed(() => store.state.creatingType !== null);

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

const renderedBody = computed(() => marked.parse(selected.value?.body ?? "", { async: false }));

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
  <aside class="detail">
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
          <NButton size="small" type="primary" :disabled="form.body.trim() === ''" @click="save">
            {{ t("node.save") }}
          </NButton>
          <NButton size="small" @click="store.cancelCreate">{{ t("node.cancel") }}</NButton>
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
          <NButton size="small" type="primary" @click="save">{{ t("node.save") }}</NButton>
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

      <dl class="meta">
        <dt>{{ t("node.file") }}</dt>
        <dd class="mono">{{ selected.file }}</dd>
        <dt>{{ t("node.dependents") }}</dt>
        <dd>
          <template v-if="selected.dependents.length === 0">—</template>
          <ul v-else class="links">
            <li v-for="id in selected.dependents" :key="id">
              <a @click="store.select(id)">{{ nodeLabel(id) }}</a>
            </li>
          </ul>
        </dd>
        <template v-if="selected.type === 'premise' && selected.confirmed !== undefined">
          <dt>{{ t("node.confirmed") }}</dt>
          <dd>{{ selected.confirmed }}</dd>
        </template>
      </dl>

      <section class="preview">
        <h3>{{ t("node.body") }}</h3>
        <!-- The body is user-authored markdown rendered locally. -->
        <div class="markdown" v-html="renderedBody" />
      </section>
    </template>

    <NEmpty v-else :description="t('node.emptySelection')" class="empty" />
  </aside>
</template>

<style scoped>
.detail {
  height: 100%;
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

.preview h3 {
  font-size: 12px;
  opacity: 0.6;
  margin: 16px 0 4px;
}

.markdown {
  font-size: 13px;
  border-top: 1px solid var(--refino-border);
  padding-top: 6px;
}
</style>
