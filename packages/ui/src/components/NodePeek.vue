<script setup lang="ts">
// Alt-peek preview card (README, "交互"): a read-only floating summary of
// the hovered node, anchored to the cursor. The cached lite shape renders
// immediately; the full record (body, rationale) fills in asynchronously
// with a latest-wins guard, and grounds render as a plain unordered list of
// summaries. The body renders as markdown, mirroring the editors' preview.
// Non-interactive by design — pointer-events stay off so the card can never
// trap the cursor; when the content overflows, wheel anywhere scrolls the
// card instead of zooming the canvas beneath. Shape and placement are pure
// geometry (peek-layout.ts) fed by the page size, the cursor and measured
// content: the card prefers a square (width follows the reflowed content
// height), extends an axis into a rectangle only at a page limit, and
// scrolls whatever still overflows.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { injectRequired } from "../context";
import { fetchGroundLites } from "../grounds";
import { renderMarkdown, renderMermaidDiagrams } from "../markdown";
import { peekState } from "../peek";
import {
  computePeekBounds,
  computePeekLayout,
  computePeekSize,
  PEEK_ESTIMATED_SIZE,
} from "../peek-layout";
import { clientKey } from "../api";
import { storeKey } from "../store";
import type { NodeRecord } from "../types";

const client = injectRequired(clientKey, "client");
const store = injectRequired(storeKey, "store");
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

const bodyText = computed(() => record.value?.body ?? "");
const rationale = computed(() => record.value?.rationale ?? "");
const summary = computed(() => {
  const value = record.value?.summary ?? "";
  return value === "" ? t("node.untitled") : value;
});
/** Rendered locally from the user-authored markdown source (editors alike). */
const renderedBody = computed(() => (bodyText.value === "" ? "" : renderMarkdown(bodyText.value)));

const cardEl = ref<HTMLElement | null>(null);
const cardSize = ref({ ...PEEK_ESTIMATED_SIZE });
const viewport = ref({ width: window.innerWidth, height: window.innerHeight });

/** Page-afforded bounds around the cursor; drive both sizing and placement. */
const bounds = computed(() =>
  computePeekBounds(viewport.value, { x: peekState.x, y: peekState.y }),
);
/** Explicit card width from the square-preferring size rule; null = auto. */
const cardWidth = ref<number | null>(null);

// Render mermaid diagrams once the preview HTML is on the page, and again
// when the source or the theme changes (editors' preview behavior).
watch([renderedBody, () => store.state.theme] as const, ([, theme]) => {
  if (renderedBody.value === "" || cardEl.value === null) return;
  void nextTick().then(async () => {
    if (cardEl.value !== null) await renderMermaidDiagrams(cardEl.value, theme);
  });
});

watch(cardEl, (el, prev) => {
  if (prev !== null) observer?.unobserve(prev);
  if (el !== null) {
    // Measure synchronously first: ResizeObserver callbacks need a rendered
    // frame, so a just-shown card would otherwise place on estimated size.
    measureSize(el);
    observer?.observe(el);
    scheduleSize();
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

// Content or bounds changes reshape the card; coalesce into one measurement.
watch([record, groundSummaries, bounds], scheduleSize);

let sizeScheduled = false;

function scheduleSize(): void {
  if (sizeScheduled) return;
  sizeScheduled = true;
  void nextTick(() => {
    sizeScheduled = false;
    refreshSize();
  });
}

/**
 * Measure the content's natural size and derive the square-preferring card
 * width (the size rule re-measures candidate widths through `measureAt`).
 * Runs synchronously — the temporary styles are restored before Vue
 * re-renders.
 */
function refreshSize(): void {
  const el = cardEl.value;
  if (el === null || !peekState.alt || peekState.id === null) return;
  const max = bounds.value;
  const prevWidth = el.style.width;
  const prevMaxHeight = el.style.maxHeight;
  el.style.maxHeight = "none";
  el.style.width = "max-content";
  const naturalWidth = Math.min(el.getBoundingClientRect().width, max.maxWidth);
  const measureAt = (width: number): number => {
    el.style.width = `${width}px`;
    return el.getBoundingClientRect().height;
  };
  const naturalHeight = measureAt(naturalWidth);
  const size = computePeekSize({
    natural: { width: naturalWidth, height: naturalHeight },
    maxWidth: max.maxWidth,
    measureHeight: measureAt,
  });
  el.style.width = `${size.width}px`;
  el.style.maxHeight = `${max.maxHeight}px`;
  const rect = el.getBoundingClientRect();
  el.style.width = prevWidth;
  el.style.maxHeight = prevMaxHeight;
  cardWidth.value = size.width;
  cardSize.value = { width: rect.width, height: rect.height };
}

/**
 * While the content overflows, the wheel scrolls the card (and never zooms
 * the canvas beneath): the card keeps pointer-events: none, so the event's
 * target is whatever sits beneath — swallow it in the capture phase.
 */
function onWheel(event: WheelEvent): void {
  const el = cardEl.value;
  if (el === null || !peekState.alt || peekState.id === null) return;
  if (event.deltaY === 0 || el.scrollHeight <= el.clientHeight) return;
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

/** Placement via pure geometry; the shape comes from the measured sizing. */
const style = computed(() => {
  const layout = computePeekLayout({
    viewport: viewport.value,
    cursor: { x: peekState.x, y: peekState.y },
    card: cardSize.value,
  });
  return {
    left: `${layout.left}px`,
    top: `${layout.top}px`,
    ...(cardWidth.value === null ? {} : { width: `${cardWidth.value}px` }),
    maxHeight: `${bounds.value.maxHeight}px`,
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
        <div v-if="renderedBody !== ''" class="body-markdown" v-html="renderedBody" />
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

.rationale {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  opacity: 0.85;
}

/* The body renders as markdown (editors' preview alike); v-html content
 * carries no scope attributes, so nested selectors go through :deep(). */
.body-markdown {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.5;
  word-break: break-word;
  opacity: 0.85;
}

.body-markdown :deep(p) {
  margin: 4px 0 0;
}

.body-markdown :deep(ul),
.body-markdown :deep(ol) {
  margin: 4px 0 0;
  padding-left: 18px;
}

.body-markdown :deep(pre) {
  margin: 4px 0 0;
  padding: 4px 6px;
  overflow-x: auto;
  border: 1px solid var(--refino-border);
  border-radius: var(--refino-radius);
}

.body-markdown :deep(table) {
  border-collapse: collapse;
}

.body-markdown :deep(th),
.body-markdown :deep(td) {
  border: 1px solid var(--refino-border);
  padding: 2px 6px;
}

.body-markdown :deep(.mermaid) {
  overflow-x: auto;
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
