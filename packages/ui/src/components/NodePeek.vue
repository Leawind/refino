<script setup lang="ts">
// Alt-peek preview card (README, "交互"): a read-only floating summary of
// the hovered node, anchored to the cursor. The cached lite shape renders
// immediately; the full record (body, rationale) fills in asynchronously
// with a latest-wins guard, and grounds render as a plain unordered list of
// summaries. Non-interactive by design — pointer-events stay off so the
// card can never trap the cursor; wheel over the card is forwarded to its
// scroller explicitly. Placement is pure geometry (peek-layout.ts) fed by
// the page size, the cursor and the card's measured size, so the card can
// grow toward its viewport-given maxima and scroll whatever still overflows.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { injectRequired } from "../context";
import { fetchGroundLites } from "../grounds";
import { peekState } from "../peek";
import { computePeekLayout, PEEK_BASE_WIDTH, PEEK_ESTIMATED_SIZE } from "../peek-layout";
import { clientKey } from "../api";
import type { NodeRecord } from "../types";

const client = injectRequired(clientKey, "client");
const { t } = useI18n();

const record = ref<NodeRecord | null>(null);
/** Ground summaries in declared order; raw ids stay out of the card. */
const groundSummaries = ref<string[]>([]);
let loadToken = 0;

watch(
  () => peekState.id,
  (id) => {
    record.value = null;
    groundSummaries.value = [];
    if (id === null) return;
    const token = ++loadToken;
    void client
      .fetchNode(id)
      .then(async (detail) => {
        if (token !== loadToken || peekState.id !== id) return;
        record.value = detail.node;
        // Ground summaries ride the batched single-hop grounds query.
        const lites = await fetchGroundLites(client, id);
        if (token !== loadToken || peekState.id !== id) return;
        groundSummaries.value = lites.map((lite) =>
          lite.summary === "" ? t("node.untitled") : lite.summary,
        );
      })
      .catch(() => {
        // The peek is best-effort; the lite shape stays visible.
      });
  },
);

const body = computed(() => record.value?.body ?? "");
const rationale = computed(() => record.value?.rationale ?? "");
const summary = computed(() => {
  const value = record.value?.summary ?? "";
  return value === "" ? t("node.untitled") : value;
});

const cardEl = ref<HTMLElement | null>(null);
const cardSize = ref({ ...PEEK_ESTIMATED_SIZE });
const viewport = ref({ width: window.innerWidth, height: window.innerHeight });

watch(cardEl, (el, prev) => {
  if (prev !== null) observer?.unobserve(prev);
  if (el !== null) {
    // Measure synchronously first: ResizeObserver callbacks need a rendered
    // frame, so a just-shown card would otherwise place on estimated size.
    measureSize(el);
    observer?.observe(el);
  }
});

let observer: ResizeObserver | null = null;

function measureSize(el: HTMLElement): void {
  // Border box: placement must account for padding and border too.
  const rect = el.getBoundingClientRect();
  cardSize.value = { width: rect.width, height: rect.height };
}

function measure(entry: ResizeObserverEntry): void {
  const box = entry.borderBoxSize?.[0];
  if (box !== undefined) {
    cardSize.value = { width: box.inlineSize, height: box.blockSize };
  } else if (cardEl.value !== null) {
    measureSize(cardEl.value);
  }
}

function onResize(): void {
  viewport.value = { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Wheel over the card scrolls its content (and nothing else): the card
 * keeps pointer-events: none, so the event's target is whatever sits
 * beneath — swallow it in the capture phase to keep the canvas from
 * treating it as zoom.
 */
function onWheel(event: WheelEvent): void {
  const el = cardEl.value;
  if (el === null || !peekState.alt || peekState.id === null) return;
  if (event.deltaY === 0 || el.scrollHeight <= el.clientHeight) return;
  const rect = el.getBoundingClientRect();
  if (
    event.clientX < rect.left ||
    event.clientX >= rect.right ||
    event.clientY < rect.top ||
    event.clientY >= rect.bottom
  ) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  el.scrollTop += event.deltaY;
}

onMounted(() => {
  observer = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    if (entry !== undefined) measure(entry);
  });
  if (cardEl.value !== null) observer.observe(cardEl.value);
  window.addEventListener("resize", onResize);
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
});

onUnmounted(() => {
  observer?.disconnect();
  window.removeEventListener("resize", onResize);
  window.removeEventListener("wheel", onWheel, { capture: true });
});

/** Placement via pure geometry; the card caps at the roomier side per axis. */
const style = computed(() => {
  const layout = computePeekLayout({
    viewport: viewport.value,
    cursor: { x: peekState.x, y: peekState.y },
    card: cardSize.value,
  });
  return {
    left: `${layout.left}px`,
    top: `${layout.top}px`,
    width: `min(${PEEK_BASE_WIDTH}px, ${layout.maxWidth}px)`,
    maxHeight: `${layout.maxHeight}px`,
  };
});
</script>

<template>
  <Teleport to="body">
    <Transition name="peek">
      <aside
        v-if="peekState.alt && peekState.id !== null"
        ref="cardEl"
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
        <template v-if="groundSummaries.length > 0">
          <p class="grounds-label">{{ t("node.grounds") }}</p>
          <ul class="grounds">
            <li v-for="(ground, index) in groundSummaries" :key="index">{{ ground }}</li>
          </ul>
        </template>
      </aside>
    </Transition>
  </Teleport>
</template>

<style scoped>
.peek {
  position: fixed;
  z-index: 1000;
  /* Border box: placement caps and the measured size must share one metric. */
  box-sizing: border-box;
  overflow: hidden auto;
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
.body {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  opacity: 0.85;
}

.grounds-label {
  margin: 6px 0 0;
  font-size: 11px;
  opacity: 0.55;
}

/* Grounds render as a plain unordered list of summaries (README, "交互"). */
.grounds {
  margin: 2px 0 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.5;
  opacity: 0.85;
}

.grounds li {
  word-break: break-word;
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
