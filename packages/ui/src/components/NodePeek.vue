<script setup lang="ts">
// Alt-peek preview card (README, "交互"): a read-only floating summary of
// the hovered node, anchored to the cursor. The cached lite shape renders
// immediately; the full record (body, rationale, grounds) fills in
// asynchronously with a latest-wins guard. Non-interactive by design —
// pointer-events stay off so the card can never trap the cursor.
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { injectRequired } from "../context";
import { peekState } from "../peek";
import { clientKey } from "../api";
import type { NodeRecord } from "../types";

const client = injectRequired(clientKey, "client");
const { t } = useI18n();

const MAX_BODY_CHARS = 600;
const MAX_RATIONALE_CHARS = 280;

const record = ref<NodeRecord | null>(null);
let loadToken = 0;

watch(
  () => peekState.id,
  (id) => {
    record.value = null;
    if (id === null) return;
    const token = ++loadToken;
    void client
      .fetchNode(id)
      .then((detail) => {
        if (token === loadToken && peekState.id === id) record.value = detail.node;
      })
      .catch(() => {
        // The peek is best-effort; the lite shape stays visible.
      });
  },
);

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const body = computed(() => {
  const value = record.value?.body ?? "";
  return value === "" ? "" : clip(value, MAX_BODY_CHARS);
});
const rationale = computed(() => {
  const value = record.value?.rationale ?? "";
  return value === "" ? "" : clip(value, MAX_RATIONALE_CHARS);
});
const grounds = computed(() => record.value?.grounds ?? []);
const summary = computed(() => {
  const value = record.value?.summary ?? "";
  return value === "" ? t("node.untitled") : value;
});

/** Card position: cursor + offset, flipped to stay inside the viewport. */
const style = computed(() => {
  const width = 380;
  const height = 320;
  const margin = 16;
  const x =
    peekState.x + margin + width <= window.innerWidth
      ? peekState.x + margin
      : Math.max(8, peekState.x - margin - width);
  const y =
    peekState.y + margin + height <= window.innerHeight
      ? peekState.y + margin
      : Math.max(8, peekState.y - margin - height);
  return { left: `${x}px`, top: `${y}px`, width: `${width}px` };
});
</script>

<template>
  <Teleport to="body">
    <Transition name="peek">
      <aside
        v-if="peekState.alt && peekState.id !== null"
        class="peek"
        :style="style"
        aria-hidden="true"
      >
        <div class="head">
          <span class="type" :class="record?.type ?? ''">{{
            record?.type === "premise" ? t("node.premise") : t("node.constraint")
          }}</span>
          <span class="id">{{ peekState.id }}</span>
        </div>
        <p class="summary">{{ summary }}</p>
        <p v-if="rationale !== ''" class="rationale">{{ rationale }}</p>
        <p v-if="body !== ''" class="body">{{ body }}</p>
        <p v-if="grounds.length > 0" class="grounds">
          {{ t("node.grounds") }}: {{ grounds.join(", ") }}
        </p>
      </aside>
    </Transition>
  </Teleport>
</template>

<style scoped>
.peek {
  position: fixed;
  z-index: 1000;
  max-height: 60vh;
  overflow: hidden;
  padding: 10px 12px;
  border-radius: var(--refino-radius);
  background: var(--refino-surface);
  border: 1px solid var(--refino-border);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.22);
  pointer-events: none;
  user-select: none;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}

.type {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--refino-border);
  opacity: 0.8;
}

.type.premise {
  border-style: dashed;
}

.id {
  font-family: monospace;
  font-size: 10px;
  opacity: 0.55;
}

.summary {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
}

.rationale,
.body,
.grounds {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  opacity: 0.85;
}

.grounds {
  font-family: monospace;
  font-size: 11px;
  opacity: 0.65;
}

.peek-enter-active,
.peek-leave-active {
  transition: opacity 0.1s ease;
}

.peek-enter-from,
.peek-leave-to {
  opacity: 0;
}
</style>
