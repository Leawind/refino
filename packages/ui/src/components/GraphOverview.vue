<script setup lang="ts">
// Project-overview cold start (README, "布局"): with nothing selected the
// canvas shows the root constraints — the top of the decision space — as
// clickable cards plus the project counts. Clicking a card selects the node
// and expands its neighborhood like any other selection.
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { injectRequired } from "../context";
import { clientKey } from "../api";
import { workspaceKey } from "../workspace";
import type { SearchNode } from "../types";

const client = injectRequired(clientKey, "client");
const workspace = injectRequired(workspaceKey, "workspace");
const { t } = useI18n();

const stats = ref<{ nodes: number; constraints: number; premises: number; roots: number } | null>(
  null,
);
const roots = ref<SearchNode[]>([]);
const extraRoots = ref(0);

onMounted(async () => {
  try {
    const [counts, page] = await Promise.all([
      client.fetchStats(),
      client.search({ roots: true, limit: 12 }),
    ]);
    stats.value = counts;
    roots.value = page.nodes;
    extraRoots.value = page.nextCursor !== undefined ? counts.roots - page.nodes.length : 0;
  } catch {
    // The overview is best-effort; the empty hint stays.
  }
});

function pick(node: SearchNode): void {
  workspace.select(node);
}
</script>

<template>
  <div class="overview">
    <h2>{{ t("overview.title") }}</h2>
    <p v-if="stats !== null" class="counts">
      <span>{{ t("node.constraints") }}: {{ stats.constraints }}</span>
      <span>{{ t("node.premises") }}: {{ stats.premises }}</span>
      <span>{{ t("overview.roots") }}: {{ stats.roots }}</span>
    </p>
    <ul class="cards">
      <li v-for="root in roots" :key="root.id">
        <button class="card" :title="t('overview.pick')" @click="pick(root)">
          <span class="summary">{{ root.summary === "" ? t("node.untitled") : root.summary }}</span>
        </button>
      </li>
    </ul>
    <p v-if="extraRoots > 0" class="more">
      {{ t("overview.more", { count: extraRoots }) }}
    </p>
  </div>
</template>

<style scoped>
.overview {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  overflow: auto;
  pointer-events: none;
}

.overview > :deep(*) {
  pointer-events: auto;
}

h2 {
  margin: 0;
  font-size: 15px;
  opacity: 0.8;
}

.counts {
  display: flex;
  gap: 16px;
  margin: 0;
  font-size: 12px;
  opacity: 0.6;
}

.cards {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  margin: 0;
  padding: 0;
  max-width: 640px;
  list-style: none;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 190px;
  padding: 10px 12px;
  text-align: left;
  border-radius: var(--refino-radius);
  background: var(--refino-surface);
  border: 1px solid var(--refino-border);
  cursor: pointer;
  font: inherit;
  color: inherit;
}

.card:hover {
  border-color: var(--refino-primary, #18a058);
}

.card .summary {
  font-size: 12px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.more {
  margin: 0;
  font-size: 12px;
  opacity: 0.6;
}
</style>
