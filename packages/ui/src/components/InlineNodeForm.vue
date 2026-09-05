<script setup lang="ts">
// Inline row editor of the resource explorer (README, "编辑功能"): one
// property per full-width row, single-column. Shares the store's edit
// session with the modal editor (base snapshot, revision, field merges);
// the row is row-scoped and does not follow the canvas focus. Conflict
// decisions and deletion stay in the modal — the row escalates there.
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { NButton, NInput, NSelect, useMessage } from "naive-ui";
import { injectRequired } from "../context";
import { clientKey } from "../api";
import { storeKey } from "../store";
import type { NodePayload } from "../types";

const client = injectRequired(clientKey, "client");
const store = injectRequired(storeKey, "store");
const { t } = useI18n();
const message = useMessage();

const props = defineProps<{ nodeId: string }>();

const node = computed(() => store.state.detail.node);
const active = computed(
  () => store.state.inlineId === props.nodeId && node.value?.id === props.nodeId,
);
const type = computed(() => node.value?.type ?? "constraint");
const conflict = computed(() => store.state.detail.conflict !== null);
const deletedWithEdits = computed(() => store.state.detail.deletedWithEdits);

const form = store.form;

const bodyRows = 8;

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
  if (node.value === null) return;
  try {
    await store.update(node.value.id, payload(), store.state.detail.revision ?? undefined);
    message.success(t("node.save"));
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}

function openEditor(): void {
  store.openDetail(props.nodeId);
}

// Grounds options via the paginated search endpoint; the fetched page
// replaces the list while already-selected ids stay labelled.
const groundOptions = ref<Array<{ label: string; value: string }>>([]);
let groundSearchToken = 0;

async function searchGrounds(q: string): Promise<void> {
  const token = ++groundSearchToken;
  try {
    const page = await client.search({ q: q.trim(), limit: 50 });
    if (token !== groundSearchToken) return;
    groundOptions.value = page.nodes
      .filter((entry) => entry.id !== props.nodeId)
      .map((entry) => ({
        label: `${entry.id} ${entry.summary === "" ? t("node.untitled") : entry.summary}`,
        value: entry.id,
      }));
  } catch {
    // Keep the previous options on failure.
  }
}

watch(active, (shown) => {
  if (shown) void searchGrounds("");
});
</script>

<template>
  <div v-if="active" class="inline-form" @keydown.stop>
    <p v-if="conflict" class="notice conflict">
      {{ t("detail.conflictTitle") }}
      <NButton size="tiny" quaternary @click="openEditor">{{ t("inline.resolve") }}</NButton>
    </p>
    <p v-else-if="deletedWithEdits" class="notice conflict">
      {{ t("detail.deletedTitle") }}
      <NButton size="tiny" quaternary @click="openEditor">{{ t("inline.resolve") }}</NButton>
    </p>

    <label class="field">
      <span class="label">{{ t("node.summary") }}</span>
      <NInput
        v-model:value="form.summary"
        size="small"
        :placeholder="t('node.summaryPlaceholder')"
      />
    </label>

    <label class="field">
      <span class="label">{{ t("node.body") }}</span>
      <NInput
        v-model:value="form.body"
        type="textarea"
        size="small"
        :rows="3"
        :max-rows="bodyRows"
        :placeholder="t('node.bodyPlaceholder')"
      />
    </label>

    <label v-if="type === 'constraint'" class="field">
      <span class="label">{{ t("node.rationale") }}</span>
      <NInput
        v-model:value="form.rationale"
        type="textarea"
        size="small"
        :rows="2"
        :max-rows="4"
        :placeholder="t('node.rationalePlaceholder')"
      />
    </label>

    <div v-if="type === 'constraint'" class="field">
      <span class="label">{{ t("node.grounds") }}</span>
      <NSelect
        :value="form.grounds"
        multiple
        filterable
        remote
        clearable
        size="small"
        :max-tag-count="3"
        :options="groundOptions"
        :placeholder="t('node.groundsPlaceholder')"
        @search="searchGrounds"
        @update:value="(value: string[]) => (form.grounds = value)"
      />
    </div>

    <label v-if="type === 'premise'" class="field">
      <span class="label">{{ t("node.confirmed") }}</span>
      <NInput v-model:value="form.confirmed" size="small" placeholder="RFC 3339" />
    </label>

    <div class="actions">
      <NButton size="tiny" quaternary @click="store.resetDetailForm()">
        {{ t("inline.reset") }}
      </NButton>
      <NButton size="tiny" quaternary @click="openEditor">
        {{ t("inline.openEditor") }}
      </NButton>
      <NButton size="tiny" type="primary" secondary @click="save">
        {{ t("node.save") }}
      </NButton>
    </div>
  </div>
</template>

<style scoped>
.inline-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px 10px;
  border-top: 1px dashed var(--refino-border);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.label {
  font-size: 11px;
  opacity: 0.65;
}

.notice {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 4px 8px;
  font-size: 12px;
  border-radius: 6px;
  background: rgba(208, 48, 80, 0.1);
  color: #d03050;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
</style>
