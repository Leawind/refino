<script setup lang="ts">
// Grounds editor shared by the modal editor and the inline row form
// (README, "编辑功能"): one ground per full-width row, rendered as its
// summary — raw ids mean nothing to users and stay out of sight (they live
// in the peek card and the editor head). Rows support Alt+hover peeking;
// removal is per-row, appending goes through the compact remote search
// select. Unknown (dangling) grounds fall back to their id.
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { NSelect } from "naive-ui";
import { clientKey, type RefinoClient } from "../api";
import { fetchGroundLites } from "../grounds";
import { injectRequired } from "../context";
import { peekHide, peekMove } from "../peek";

const client = injectRequired(clientKey, "client");
const { t } = useI18n();

const props = defineProps<{
  /** Current grounds, in declared order (the editor form's field). */
  grounds: string[];
  /** The edited node; its grounds resolve in one batched query. Null in
   * create mode, where summaries arrive via the search options. */
  ownerId: string | null;
}>();

const emit = defineEmits<{ "update:grounds": [grounds: string[]] }>();

/** Summaries seen so far, seeded by the batched query and search pages. */
const known = ref(new Map<string, string>());

watch(
  () => props.ownerId,
  async (ownerId) => {
    if (ownerId === null) return;
    const lites = await fetchGroundLites(client, ownerId);
    known.value = new Map([
      ...known.value,
      ...lites.map((lite) => [lite.id, lite.summary] as const),
    ]);
  },
  { immediate: true },
);

/** Rows in declared order; unresolved or summary-less grounds show the id. */
const rows = computed(() =>
  props.grounds.map((id) => ({
    id,
    label: known.value.get(id) || id,
  })),
);

function remove(id: string): void {
  emit(
    "update:grounds",
    props.grounds.filter((ground) => ground !== id),
  );
}

function onRowMove(event: MouseEvent, id: string): void {
  peekMove(id, event.clientX, event.clientY);
}

// Append select: remote search over the paginated endpoint; selected ids
// join the end of the list (grounds order is meaningful) and the select
// resets for the next pick.
const PAGE_SIZE = 50;
const options = ref<Array<{ label: string; value: string }>>([]);
const picked = ref<string | null>(null);
let searchToken = 0;

async function search(q: string): Promise<void> {
  const token = ++searchToken;
  try {
    const page = await client.search({ q: q.trim(), limit: PAGE_SIZE });
    if (token !== searchToken) return;
    options.value = page.nodes
      .filter((node) => node.id !== props.ownerId && !props.grounds.includes(node.id))
      .map((node) => {
        // Seed the summary so the appended row renders it immediately.
        known.value.set(node.id, node.summary);
        return {
          label: node.summary === "" ? t("node.untitled") : node.summary,
          value: node.id,
        };
      });
  } catch {
    // Keep the previous options on failure.
  }
}

function append(id: string | null): void {
  picked.value = null;
  if (id === null || props.grounds.includes(id)) return;
  emit("update:grounds", [...props.grounds, id]);
}
</script>

<template>
  <div class="grounds-field">
    <ul v-if="rows.length > 0" class="grounds-list">
      <li
        v-for="row in rows"
        :key="row.id"
        @mousemove="onRowMove($event, row.id)"
        @mouseleave="peekHide(row.id)"
      >
        <span class="summary" :title="row.id">{{ row.label }}</span>
        <button class="remove" :title="t('node.groundsRemove')" @click.stop="remove(row.id)">
          ×
        </button>
      </li>
    </ul>
    <NSelect
      :value="picked"
      filterable
      clearable
      remote
      size="small"
      :options="options"
      :placeholder="t('node.groundsAdd')"
      :aria-label="t('node.grounds')"
      @search="search"
      @update:value="append"
    />
  </div>
</template>

<style scoped>
.grounds-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  min-width: 0;
}

.grounds-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.grounds-list li {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px;
  border-radius: 6px;
}

.grounds-list li:hover {
  background: rgba(128, 128, 128, 0.12);
}

.grounds-list li::before {
  content: "•";
  flex: none;
  opacity: 0.55;
}

.summary {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.remove {
  flex: none;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  padding: 0 4px;
  opacity: 0.6;
}

.remove:hover {
  opacity: 1;
  color: #d03050;
}
</style>
