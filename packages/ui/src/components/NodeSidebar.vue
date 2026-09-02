<script setup lang="ts">
// Left sidebar: search box and the node list.
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { NButton, NInput, NTag, NTooltip } from "naive-ui";
import { store } from "../store";

const { t } = useI18n();

const query = ref("");

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  const nodes = [...store.state.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (q === "") return nodes;
  return nodes.filter((n) => n.id.toLowerCase().includes(q) || n.summary.toLowerCase().includes(q));
});

function titleOf(summary: string): string {
  return summary === "" ? t("node.untitled") : summary;
}
</script>

<template>
  <aside class="sidebar">
    <div class="toolbar">
      <NInput
        v-model:value="query"
        size="small"
        clearable
        :placeholder="t('node.searchPlaceholder')"
      />
    </div>
    <div class="create-row">
      <NTooltip>
        <template #trigger>
          <NButton size="tiny" @click="store.startCreate('premise')"
            >+{{ t("node.premise") }}</NButton
          >
        </template>
        {{ t("node.createPremise") }}
      </NTooltip>
      <NTooltip>
        <template #trigger>
          <NButton size="tiny" @click="store.startCreate('constraint')"
            >+{{ t("node.constraint") }}</NButton
          >
        </template>
        {{ t("node.createConstraint") }}
      </NTooltip>
    </div>

    <ul class="list">
      <li
        v-for="node in filtered"
        :key="node.id"
        class="item"
        :class="{ selected: node.id === store.state.selectedId }"
        @click="store.select(node.id)"
      >
        <div class="item-head">
          <span class="id">{{ node.id }}</span>
          <NTag
            size="tiny"
            :bordered="false"
            :type="node.type === 'premise' ? 'default' : 'primary'"
          >
            {{ t(`node.${node.type}`) }}
          </NTag>
        </div>
        <div class="summary">{{ titleOf(node.summary) }}</div>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.toolbar {
  padding: 10px 10px 6px;
}

.create-row {
  display: flex;
  gap: 6px;
  padding: 0 10px 10px;
  border-bottom: 1px solid var(--refino-border);
}

.list {
  flex: 1;
  overflow-y: auto;
  margin: 0;
  padding: 6px;
  list-style: none;
}

.item {
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
}

.item:hover {
  background: rgba(128, 128, 128, 0.12);
}

.item.selected {
  background: rgba(24, 160, 88, 0.15);
}

.item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.id {
  font-family: monospace;
  font-size: 12px;
  opacity: 0.75;
}

.summary {
  font-size: 13px;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
