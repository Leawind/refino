<script setup lang="ts">
// Review drawer (README, "审阅抽屉"): the bell accumulates changes since the
// last look; the drawer lists them with their write origin and the server's
// pending-review queue with per-node acknowledgements. Acknowledgements are
// client preferences — the graph is never touched.
import { useI18n } from "vue-i18n";
import { NBadge, NButton, NDrawer, NDrawerContent, NEmpty, NTag } from "naive-ui";
import { NotificationsOutline } from "@vicons/ionicons5";
import { NIcon } from "naive-ui";
import { injectRequired } from "../context";
import { workspaceKey } from "../workspace";
import { reviewKey } from "../review";

const review = injectRequired(reviewKey, "review");
const workspace = injectRequired(workspaceKey, "workspace");
const { t } = useI18n();

function locate(id: string): void {
  const cached = workspace.displayed.value.find((node) => node.id === id);
  workspace.select(cached ?? { id, type: "constraint", summary: "" });
}

/** Entries render by summary; the id is the last resort for nodes the
 * client never saw (typically externally deleted ones). */
function labelOf(id: string): string {
  const cached = workspace.displayed.value.find((node) => node.id === id);
  return cached === undefined || cached.summary === "" ? id : cached.summary;
}
</script>

<template>
  <button
    class="nav-btn"
    :aria-label="t('review.bell')"
    :title="t('review.bell')"
    @click="review.openDrawer()"
  >
    <NBadge :value="review.unseen.value.length" :max="99" :show="review.unseen.value.length > 0">
      <NIcon :component="NotificationsOutline" />
    </NBadge>
  </button>
  <NDrawer
    :show="review.state.open"
    :width="420"
    placement="right"
    @update:show="review.closeDrawer()"
  >
    <NDrawerContent :title="t('review.title')" closable>
      <section class="section">
        <h3>{{ t("review.pending") }} ({{ review.pendingVisible.value.length }})</h3>
        <NEmpty
          v-if="review.pendingVisible.value.length === 0"
          :description="t('review.none')"
          size="small"
        />
        <ul v-else class="entries">
          <li v-for="node in review.pendingVisible.value" :key="node.id" class="entry">
            <div class="texts">
              <span class="summary">
                {{ node.summary === "" ? t("node.untitled") : node.summary }}
              </span>
            </div>
            <span class="actions">
              <NButton size="tiny" quaternary @click="locate(node.id)">
                {{ t("review.locate") }}
              </NButton>
              <NButton size="tiny" quaternary @click="review.ack(node.id)">
                {{ t("review.ack") }}
              </NButton>
            </span>
          </li>
        </ul>
      </section>

      <section class="section">
        <h3>{{ t("review.changes") }} ({{ review.state.entries.length }})</h3>
        <NEmpty
          v-if="review.state.entries.length === 0"
          :description="t('review.none')"
          size="small"
        />
        <ul v-else class="entries">
          <li
            v-for="entry in [...review.state.entries].reverse()"
            :key="entry.id"
            class="entry"
            :class="{ deleted: entry.deleted }"
          >
            <div class="texts">
              <span class="summary" :class="{ unknown: labelOf(entry.id) === entry.id }">
                {{ labelOf(entry.id) }}
              </span>
              <NTag v-if="entry.deleted" size="tiny" type="error" :bordered="false">
                {{ t("review.deleted") }}
              </NTag>
              <NTag v-else size="tiny" :bordered="false">
                {{ entry.origin === "api" ? t("review.originApi") : t("review.originFile") }}
              </NTag>
            </div>
            <span class="actions">
              <NButton v-if="!entry.deleted" size="tiny" quaternary @click="locate(entry.id)">
                {{ t("review.locate") }}
              </NButton>
            </span>
          </li>
        </ul>
      </section>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.nav-btn {
  width: 46px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  cursor: pointer;
  color: inherit;
  font: inherit;
  padding: 0;
}

.nav-btn:hover {
  color: var(--refino-primary, #18a058);
}

.section {
  margin-bottom: 20px;
}

.section h3 {
  font-size: 13px;
  margin: 0 0 8px;
  opacity: 0.75;
}

.entries {
  margin: 0;
  padding: 0;
  list-style: none;
}

.entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 6px;
}

.entry:hover {
  background: rgba(128, 128, 128, 0.1);
}

.texts {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* Fallback rows for nodes the client never saw still show the raw id. */
.summary.unknown {
  font-family: monospace;
}

.entry.deleted .summary {
  text-decoration: line-through;
  opacity: 0.6;
}

.summary {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.75;
}

.actions {
  flex: none;
  display: flex;
  gap: 2px;
}
</style>
