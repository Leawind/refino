<script setup lang="ts">
// Orbit callout (ui DESIGN.md, "三维视图"): the focused star's content floats
// in the emptiest part of the picture — no panel, no border — and a leader
// joins it to a point just short of the star. A rule cuts the content in two:
// the summary sits above it, the markdown body below. The spot is re-solved
// as the camera turns (graph/orbit/callout.ts), the block eases towards each
// new spot, and the body scrolls in place when the page affords less height
// than the content needs.
//
// Geometry is written straight to the DOM every frame instead of going
// through reactivity: the block moves while the camera moves, and a render
// pass per frame would be wasted work.
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { useI18n } from "vue-i18n";
import { clientKey } from "../api";
import { injectRequired } from "../context";
import {
  calloutHeightCap,
  calloutLeader,
  calloutWidths,
  chooseCalloutPlacement,
  placeSummaryLabels,
  SUMMARY_FONT_SIZE,
  SUMMARY_LABEL_LINE,
  SUMMARY_RULE_GAP,
} from "../graph/orbit/callout";
import type {
  CalloutCandidate,
  CalloutPlacement,
  CalloutRect,
  CalloutStar,
  SummaryLabelCandidate,
  SummaryLabelPlacement,
} from "../graph/orbit/callout";
import { easeBlend } from "../graph/orbit/camera";
import type { OrbitTheme } from "../graph/orbit/theme";
import type { OrbitScene, OrbitScreenLayout } from "../graph/orbit/scene";
import { peekState } from "../peek";
import { renderMarkdown } from "../markdown";
import type { NodeLite, NodeRecord } from "../types";

/** Re-solve the spot this often while the camera turns: the block eases
 * between solutions, so a coarse cadence never shows. */
const PLACE_INTERVAL_MS = 110;
/** Time constant of the glide to the next spot. */
const MOVE_TAU_MS = 150;
/** Space kept between the block and the canvas edge controls. */
const PANEL_PAD = 10;
const props = defineProps<{
  scene: OrbitScene;
  node: NodeLite | null;
  /** Summaries of the displayed nodes, for the orbiting premises. */
  summaries: ReadonlyMap<string, string>;
  /** Font scale of the content and its summaries. */
  textScale: number;
  /** Palette the overlay follows; the scene and the typography share it. */
  theme: OrbitTheme;
}>();

const client = injectRequired(clientKey, "client");

/** The palette as CSS custom properties for the stylesheet and SVG stops. */
const themeVars = computed(() => ({
  "--orbit-text": props.theme.text,
  "--orbit-label": props.theme.label,
  "--orbit-text-soft": props.theme.textSoft,
  "--orbit-accent": props.theme.accent,
  "--orbit-fill": props.theme.fill,
  "--orbit-line": props.theme.line,
  "--orbit-shadow": props.theme.textShadow,
  "--orbit-text-scale": String(props.textScale),
}));
const { t } = useI18n();

const layerEl = ref<HTMLElement | null>(null);
const blockEl = ref<HTMLElement | null>(null);
const bodyEl = ref<HTMLElement | null>(null);
const ruleEl = ref<HTMLElement | null>(null);
/** One polyline per connector: the leader up to the star, then the rule
 * itself. Drawing both in a single stroke is what makes the corner an elbow
 * of one continuous line instead of two hairlines meeting at an angle. */
const leaderEl = ref<SVGPolylineElement | null>(null);
const gradientEl = ref<SVGLinearGradientElement | null>(null);
const gradientId = `${useId()}-leader`;
const scrollable = ref(false);
const clipped = ref(false);
const ready = ref(false);

/** Full record of the focused node: the summary rides the working set, the
 * body only comes with the record. */
const record = ref<NodeRecord | null>(null);
let loadToken = 0;

watch(
  () => props.node?.id ?? null,
  (id) => {
    record.value = null;
    if (id === null) return;
    const token = ++loadToken;
    void client
      .fetchNode(id)
      .then((detail) => {
        if (token !== loadToken) return;
        record.value = detail.node;
      })
      .catch(() => {
        // The callout is best-effort; the summary alone still says what it is.
      });
  },
  // The overlay can mount with a focus already in place (the scene comes up
  // after the first click).
  { immediate: true },
);

const summary = computed(() => {
  const value = props.node?.summary || record.value?.summary || "";
  return value === "" ? t("node.untitled") : value;
});
const bodyHtml = computed(() => {
  const body = record.value?.body ?? "";
  return body === "" ? "" : renderMarkdown(body);
});

/** Full record of the hovered star: its label unfolds the body on Alt. The
 * id travels through the scene's screen layout, so a premise copy shares the
 * record with every other copy of the same node. */
const hoveredId = ref<string | null>(null);
const hoveredRecord = ref<NodeRecord | null>(null);
let hoverLoadToken = 0;

watch(
  hoveredId,
  (id) => {
    hoveredRecord.value = null;
    if (id === null) return;
    const token = ++hoverLoadToken;
    void client
      .fetchNode(id)
      .then((detail) => {
        if (token !== hoverLoadToken || hoveredId.value !== id) return;
        hoveredRecord.value = detail.node;
      })
      .catch(() => {
        // The label still shows the summary; the body is best-effort.
      });
  },
  { immediate: true },
);

const hoveredBodyHtml = computed(() => {
  const body = hoveredRecord.value?.body ?? "";
  return body === "" ? "" : renderMarkdown(body);
});

/** Geometry, all in canvas-local CSS pixels. */
const shown = { left: 0, top: 0, width: 0 };
let target: CalloutPlacement | null = null;
let candidates: CalloutCandidate[] = [];
let needsMeasure = true;
let needsPlace = true;
let placed = false;
let ruleOffset = 0;
let ruleDirty = true;
let scrollDirty = true;
let scrollCheckedAt = 0;
let frameTime = 0;
let placedAt = 0;

/** Summary labels of the picture's prominent stars and the focus's grounds. */
const summaryLabels = ref<SummaryLabelPlacement[]>([]);
let summarySignature = "";
const summaryEls = new Map<string, HTMLElement>();
/** The rendered rule inside its box, in box-local pixels. The text's real
 * wrapping decides this; the character-count estimate used for placement can
 * be a line off. */
interface RuleGeometry {
  left: number;
  y: number;
  width: number;
}

/** Measured rules, keyed by label. */
const summaryRuleGeometries = new Map<string, RuleGeometry>();

function measureSummaryRule(
  key: string,
  element: HTMLElement,
  fallback: { left: number; y: number; width: number },
): RuleGeometry {
  const cached = summaryRuleGeometries.get(key);
  if (cached !== undefined) return cached;
  const rule = element.querySelector<HTMLElement>(".satellite-rule");
  if (rule === null) return fallback;
  const labelRect = element.getBoundingClientRect();
  const ruleRect = rule.getBoundingClientRect();
  if (labelRect.height === 0 || ruleRect.height === 0) return fallback;
  const geometry = {
    left: ruleRect.left - labelRect.left,
    y: ruleRect.top - labelRect.top + ruleRect.height / 2,
    width: ruleRect.width,
  };
  if (
    !Number.isFinite(geometry.left) ||
    !Number.isFinite(geometry.y) ||
    !Number.isFinite(geometry.width) ||
    geometry.width <= 0
  ) {
    return fallback;
  }
  summaryRuleGeometries.set(key, geometry);
  return geometry;
}

function onFrame(): void {
  const now = performance.now();
  const delta = frameTime === 0 ? 16 : Math.min(64, now - frameTime);
  frameTime = now;
  const layout = props.scene.screenLayout();
  const obstacles = measureObstacles();
  // The hovered star's record feeds its label's Alt body. Read it from the
  // layout so this overlay needs no second hover source.
  const hovered = layout.nodes.find((node) => node.hovered);
  const nextHovered = hovered?.id ?? null;
  if (nextHovered !== hoveredId.value) hoveredId.value = nextHovered;
  // Summaries follow the picture, not the focus: they stay while the camera
  // turns even when no star is focused and the main block is unmounted.
  updateSummaries(layout, obstacles);
  const el = blockEl.value;
  if (el === null || props.node === null) {
    hideLeader();
    frameTime = 0;
    return;
  }
  if (needsMeasure) {
    measureCandidates(el);
    needsMeasure = false;
    needsPlace = true;
  }
  if (needsPlace || now - placedAt >= PLACE_INTERVAL_MS) {
    solve(layout, obstacles);
    placedAt = now;
    needsPlace = false;
  }
  if (target === null) return;
  let moving = false;
  if (!placed) {
    // A new node appears where it belongs instead of gliding over the old
    // content's spot.
    shown.left = target.left;
    shown.top = target.top;
    shown.width = target.width;
    placed = true;
  } else {
    const blend = easeBlend(delta, MOVE_TAU_MS);
    for (const key of ["left", "top", "width"] as const) {
      const difference = target[key] - shown[key];
      if (Math.abs(difference) > 0.3) {
        shown[key] += difference * blend;
        moving = true;
      } else {
        shown[key] = target[key];
      }
    }
  }
  applyGeometry(el);
  if (ruleDirty || moving) {
    measureRule(el);
    ruleDirty = false;
  }
  drawLeader();
  if (!ready.value) ready.value = true;
  // The overflow only settles with the width; a label that moves with its
  // star can still change the body's fit, so check anyway every so often.
  if (scrollDirty && (!moving || now - scrollCheckedAt > 200)) {
    refreshScroll();
    scrollDirty = false;
    scrollCheckedAt = now;
  }
  if (moving) props.scene.requestRender();
}

function applyGeometry(el: HTMLElement): void {
  el.style.transform = `translate3d(${shown.left}px, ${shown.top}px, 0)`;
  el.style.width = `${shown.width}px`;
  el.style.maxHeight = `${calloutHeightCap(props.scene.viewport)}px`;
}

/** Natural height of the content at every width the block may take: the
 * placement needs the shape the text reflows into, not just the width. */
function measureCandidates(el: HTMLElement): void {
  const viewport = props.scene.viewport;
  const widths = calloutWidths(viewport);
  const cap = calloutHeightCap(viewport);
  const width = el.style.width;
  const maxHeight = el.style.maxHeight;
  // Temporary styles are restored before the browser can paint them.
  el.style.maxHeight = "none";
  candidates = widths.map((candidate) => {
    el.style.width = `${candidate}px`;
    const natural = el.getBoundingClientRect().height;
    return { width: candidate, contentHeight: natural, height: Math.min(natural, cap) };
  });
  el.style.width = width;
  el.style.maxHeight = maxHeight;
  scrollDirty = true;
}

function solve(layout: OrbitScreenLayout, controls: CalloutRect[]): void {
  if (layout.anchor === null || candidates.length === 0) {
    target = null;
    return;
  }
  // Satellite summaries move with their rings; the main block must avoid
  // them as well as the stars and the canvas controls.
  const obstacles = [...controls];
  for (const label of summaryLabels.value) {
    obstacles.push({
      left: label.left,
      top: label.top,
      width: label.width,
      height: label.height,
    });
  }
  target = chooseCalloutPlacement({
    viewport: { width: layout.width, height: layout.height },
    stars: layout.stars,
    obstacles,
    anchor: layout.anchor,
    candidates,
    previous: target,
  });
}

/** Pick the stars that earn a summary and scale their text by distance.
 * Besides the hovered star, only the focus's parent decisions and the
 * premises it grounds on speak — the picture's other stars stay quiet. */
function selectSummaryCandidates(layout: OrbitScreenLayout): SummaryLabelCandidate[] {
  const focusId = props.node?.id ?? null;
  // The camera distance to the orbit centre is the full-size reference: a
  // star at that depth reads normal, closer ones cap at normal, farther ones
  // shrink without a floor.
  const reference = Math.max(layout.referenceDistance, 1);
  const kept = layout.nodes.filter(
    (node) =>
      node.id !== focusId && props.summaries.has(node.id) && (node.hovered || node.relative),
  );
  return kept.map((node) => ({
    key: node.key,
    id: node.id,
    x: node.x,
    y: node.y,
    radius: node.radius,
    // The pointer already singles out the hovered star: it reads at normal
    // size whatever its depth. Relatives follow distance alone.
    scale: node.hovered ? 1 : Math.min(1, reference / Math.max(node.distance, 1e-3)),
    hovered: node.hovered,
  }));
}

/** Place and follow the summaries around the picture's prominent stars. */
function updateSummaries(layout: OrbitScreenLayout, obstacles: readonly CalloutRect[]): void {
  const boxes = placeSummaryLabels({
    viewport: { width: layout.width, height: layout.height },
    candidates: selectSummaryCandidates(layout),
    focus: layout.anchor,
    summaries: props.summaries,
    obstacles,
    textScale: props.textScale,
  });
  const signature = boxes
    .map(
      (box) =>
        `${box.key}:${box.text}:${box.scale.toFixed(2)}:${box.hovered ? 1 : 0}:${box.width.toFixed(0)}x${box.height.toFixed(0)}`,
    )
    .join("|");
  if (signature !== summarySignature) {
    summarySignature = signature;
    // A resized box wraps the text differently, which moves the rule.
    summaryRuleGeometries.clear();
    summaryLabels.value = boxes;
  }
  summaryEls.clear();
  const layer = layerEl.value;
  if (layer === null) return;
  for (const element of layer.querySelectorAll<HTMLElement>(".satellite-label")) {
    const key = element.dataset.satKey;
    if (key !== undefined) summaryEls.set(key, element);
  }
  const lines = new Map<string, SVGPolylineElement>();
  for (const line of layer.querySelectorAll<SVGPolylineElement>("[data-sat-line]")) {
    if (line.dataset.satLine !== undefined) lines.set(line.dataset.satLine, line);
  }
  const gradients = new Map<string, SVGLinearGradientElement>();
  for (const gradient of layer.querySelectorAll<SVGLinearGradientElement>("[data-sat-gradient]")) {
    if (gradient.dataset.satGradient !== undefined) {
      gradients.set(gradient.dataset.satGradient, gradient);
    }
  }
  for (const box of boxes) {
    const element = summaryEls.get(box.key);
    if (element !== undefined) {
      element.style.transform = `translate3d(${box.left}px, ${box.top}px, 0)`;
      element.style.width = `${box.width}px`;
      element.style.visibility = "visible";
    }
    // The rule's rendered position depends on how the text actually wrapped;
    // the estimate in `box.ruleOffset` can be a line too low. Measure it and
    // draw the leader and the rule as one polyline, so the elbow joins.
    const geometry =
      element === undefined
        ? { left: 0, y: box.ruleOffset, width: box.width }
        : measureSummaryRule(box.key, element, {
            left: 0,
            y: box.ruleOffset,
            width: box.width,
          });
    const points = connectorPoints(box.anchor, geometry, box.left, box.top, box.width, box.side);
    const line = lines.get(box.key);
    if (line !== undefined) applyConnector(line, points);
    const gradient = gradients.get(box.key);
    if (gradient !== undefined) applyGradientAxis(gradient, points.start, points.near);
  }
}

/** Gradient ids cannot carry the `@` in a satellite's copy key. */
function satelliteGradientId(key: string): string {
  return `${gradientId}-sat-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function clearSummaries(): void {
  if (summaryLabels.value.length !== 0) summaryLabels.value = [];
  summarySignature = "";
  summaryEls.clear();
  summaryRuleGeometries.clear();
}

function hideLeader(): void {
  const leader = leaderEl.value;
  if (leader !== null) leader.style.display = "none";
}

/** Canvas edge controls the block must not slide under. */
function measureObstacles(): CalloutRect[] {
  const host = layerEl.value?.parentElement;
  if (host === null || host === undefined) return [];
  const bounds = host.getBoundingClientRect();
  const obstacles: CalloutRect[] = [];
  for (const panel of host.querySelectorAll(".graph-float")) {
    const box = panel.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    obstacles.push({
      left: box.left - bounds.left - PANEL_PAD,
      top: box.top - bounds.top - PANEL_PAD,
      width: box.width + 2 * PANEL_PAD,
      height: box.height + 2 * PANEL_PAD,
    });
  }
  return obstacles;
}

/** The rendered rule inside the block, in block-local pixels. */
let ruleGeometry: RuleGeometry = { left: 0, y: 0, width: 0 };

function measureRule(el: HTMLElement): void {
  const rule = ruleEl.value;
  if (rule === null) {
    ruleOffset = 0;
    ruleGeometry = { left: 0, y: 0, width: 0 };
    return;
  }
  const block = el.getBoundingClientRect();
  const box = rule.getBoundingClientRect();
  ruleGeometry = {
    left: box.left - block.left,
    y: box.top - block.top + box.height / 2,
    width: box.width,
  };
  ruleOffset = ruleGeometry.y;
}

/**
 * One connector as a single polyline: the leader leaves just outside the
 * star, bends at the rule's near end and runs along the rule to its far end.
 * Both parts share one stroke, so the elbow joins perfectly instead of two
 * hairlines meeting at an angle (which always leaves a notch).
 */
function connectorPoints(
  anchor: CalloutStar,
  geometry: RuleGeometry,
  boxLeft: number,
  boxTop: number,
  boxWidth: number,
  side: "left" | "right",
): {
  start: { x: number; y: number };
  near: { x: number; y: number };
  far: { x: number; y: number };
} {
  const ruleLeft = boxLeft + geometry.left;
  const ruleRight = ruleLeft + geometry.width;
  const nearX = side === "left" ? ruleLeft : ruleRight;
  const farX = side === "left" ? ruleRight : ruleLeft;
  const y = boxTop + geometry.y;
  const tip = calloutLeader(anchor, { x: nearX, y });
  return { start: { x: tip.x1, y: tip.y1 }, near: { x: nearX, y }, far: { x: farX, y } };
}

function drawLeader(): void {
  const leader = leaderEl.value;
  if (leader === null) return;
  const anchor = props.scene.focusScreen();
  if (anchor === null || target === null) {
    leader.style.display = "none";
    return;
  }
  const points = connectorPoints(
    anchor,
    ruleGeometry,
    shown.left,
    shown.top,
    shown.width,
    target.side,
  );
  leader.style.display = "";
  applyConnector(leader, points);
  const gradient = gradientEl.value;
  if (gradient !== null) applyGradientAxis(gradient, points.start, points.near);
}

function applyConnector(
  element: SVGPolylineElement,
  points: {
    start: { x: number; y: number };
    near: { x: number; y: number };
    far: { x: number; y: number };
  },
): void {
  element.setAttribute(
    "points",
    `${points.start.x},${points.start.y} ${points.near.x},${points.near.y} ${points.far.x},${points.far.y}`,
  );
}

/** The gradient runs along the leader and pads past its last stop, so the
 * rule part keeps the rule's own opacity: one continuous brightness too. */
function applyGradientAxis(
  gradient: SVGLinearGradientElement,
  start: { x: number; y: number },
  end: { x: number; y: number },
): void {
  gradient.setAttribute("x1", `${start.x}`);
  gradient.setAttribute("y1", `${start.y}`);
  gradient.setAttribute("x2", `${end.x}`);
  gradient.setAttribute("y2", `${end.y}`);
}

/** Overflow state drives both the wheel and the fade that hints at more. */
function refreshScroll(): void {
  const body = bodyEl.value;
  if (body === null) {
    scrollable.value = false;
    clipped.value = false;
    return;
  }
  const overflow = body.scrollHeight > body.clientHeight + 1;
  scrollable.value = overflow;
  clipped.value = overflow && body.scrollTop + body.clientHeight < body.scrollHeight - 2;
}

function onWheel(event: WheelEvent): void {
  const body = bodyEl.value;
  if (body === null || !scrollable.value) return;
  event.preventDefault();
  body.scrollTop += event.deltaY;
  refreshScroll();
}

let observer: ResizeObserver | null = null;

onMounted(() => {
  props.scene.onFrame(onFrame);
  if (layerEl.value !== null) {
    observer = new ResizeObserver(() => {
      needsMeasure = true;
      needsPlace = true;
      // A narrower pane wraps the summaries differently: re-measure the rules.
      summaryRuleGeometries.clear();
      props.scene.requestRender();
    });
    observer.observe(layerEl.value);
  }
  props.scene.requestRender();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  props.scene.onFrame(null);
});

watch(
  () => props.node,
  () => {
    hideLeader();
    clearSummaries();
    needsMeasure = true;
    needsPlace = true;
    ruleDirty = true;
    placed = false;
    ready.value = false;
    frameTime = 0;
    // The block is measured by the next frame, after it is in the DOM.
    props.scene.requestRender();
  },
);

watch([bodyHtml, () => props.node?.summary], () => {
  needsMeasure = true;
  needsPlace = true;
  ruleDirty = true;
  props.scene.requestRender();
});
</script>

<template>
  <div ref="layerEl" class="callout-layer" :style="themeVars">
    <svg class="callout-leader" aria-hidden="true">
      <defs>
        <!-- One gradient per connector: it runs along the leader and pads
             past its end, so the rule part renders at the rule's own alpha.
             The leader therefore reaches the rule at exactly the brightness
             the rule has, which is what makes the elbow read as one line. -->
        <linearGradient
          :id="gradientId"
          ref="gradientEl"
          gradientUnits="userSpaceOnUse"
          spreadMethod="pad"
          x1="0"
          y1="0"
          x2="0"
          y2="0"
        >
          <stop offset="0" :stop-color="theme.leader" stop-opacity="0" />
          <stop offset="1" :stop-color="theme.leader" stop-opacity="0.42" />
        </linearGradient>
        <linearGradient
          v-for="label in summaryLabels"
          :key="label.key"
          :id="satelliteGradientId(label.key)"
          :data-sat-gradient="label.key"
          gradientUnits="userSpaceOnUse"
          spreadMethod="pad"
          x1="0"
          y1="0"
          x2="0"
          y2="0"
        >
          <stop offset="0" :stop-color="theme.leader" stop-opacity="0" />
          <stop offset="1" :stop-color="theme.leader" stop-opacity="0.42" />
        </linearGradient>
      </defs>
      <polyline
        ref="leaderEl"
        fill="none"
        :stroke="`url(#${gradientId})`"
        stroke-width="1"
        stroke-linecap="butt"
        stroke-linejoin="round"
      />
      <polyline
        v-for="label in summaryLabels"
        :key="label.key"
        :data-sat-line="label.key"
        fill="none"
        :stroke="`url(#${satelliteGradientId(label.key)})`"
        stroke-width="1"
        stroke-linecap="butt"
        stroke-linejoin="round"
      />
    </svg>
    <div
      v-for="label in summaryLabels"
      :key="label.key"
      class="satellite-label"
      :class="{ 'is-expanded': label.hovered && peekState.alt && hoveredBodyHtml !== '' }"
      :data-sat-key="label.key"
    >
      <span
        class="summary"
        :style="{
          fontSize: `${SUMMARY_FONT_SIZE * label.scale}px`,
          lineHeight: `${SUMMARY_LABEL_LINE * label.scale}px`,
        }"
        >{{ label.text }}</span
      >
      <div
        class="satellite-rule"
        :style="{ marginTop: `${SUMMARY_RULE_GAP * label.scale}px` }"
        aria-hidden="true"
      ></div>
      <div
        v-if="label.hovered && peekState.alt && hoveredBodyHtml !== ''"
        class="satellite-body"
        v-html="hoveredBodyHtml"
      />
    </div>
    <Transition name="callout">
      <div
        v-if="node !== null"
        ref="blockEl"
        class="callout"
        :class="{ 'is-scrollable': scrollable, 'is-ready': ready }"
        @wheel="onWheel"
      >
        <p class="summary">{{ summary }}</p>
        <div ref="ruleEl" class="rule" aria-hidden="true"></div>
        <div
          v-if="bodyHtml !== ''"
          ref="bodyEl"
          class="body"
          :class="{ 'is-clipped': clipped }"
          @scroll="refreshScroll"
          v-html="bodyHtml"
        />
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.callout-layer {
  position: absolute;
  inset: 0;
  z-index: 4;
  overflow: hidden;
  pointer-events: none;
}

.callout-leader {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

/* Premise summaries ride their stars: text above a rule, with a leader back to
 * the star; no panel, no body. */
.satellite-label {
  position: absolute;
  top: 0;
  left: 0;
  box-sizing: border-box;
  color: var(--orbit-label);
  font-size: calc(11px * var(--orbit-text-scale, 1));
  line-height: calc(19px * var(--orbit-text-scale, 1));
  text-shadow: var(--orbit-shadow);
  visibility: hidden;
  pointer-events: none;
  user-select: none;
  will-change: transform;
}

.satellite-label .summary {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow-wrap: anywhere;
}

.satellite-label .satellite-rule {
  height: 1px;
  margin-top: 6px;
  background: transparent;
}

/* Holding Alt unfolds the hovered star's body under its rule. It keeps the
 * label's borderless look and follows the same markdown styling as the main
 * block; the pointer is captured only while expanded so the body can scroll. */
.satellite-label.is-expanded {
  pointer-events: auto;
  z-index: 2;
}

.satellite-body {
  max-height: 140px;
  margin-top: 8px;
  overflow-y: auto;
  overscroll-behavior: contain;
  color: var(--orbit-text-soft);
  font-size: calc(11px * var(--orbit-text-scale, 1));
  line-height: 1.6;
  text-shadow: var(--orbit-shadow);
  overflow-wrap: anywhere;
  scrollbar-width: none;
}

.satellite-body::-webkit-scrollbar {
  display: none;
}

.satellite-body :deep(p) {
  margin: 0 0 6px;
}

.satellite-body :deep(p:last-child) {
  margin-bottom: 0;
}

.satellite-body :deep(ul),
.satellite-body :deep(ol) {
  margin: 0 0 6px;
  padding-left: 16px;
}

.satellite-body :deep(a) {
  color: var(--orbit-accent);
}

.callout {
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  visibility: hidden;
  pointer-events: none;
  user-select: none;
  will-change: transform;
}

.callout.is-ready {
  visibility: visible;
}

/* Only a scrollable body needs the pointer: everything else stays
 * transparent to the canvas underneath, so the wheel still zooms. */
.callout.is-scrollable {
  pointer-events: auto;
}

.summary {
  flex: none;
  margin: 0;
  color: var(--orbit-text);
  font-size: calc(13px * var(--orbit-text-scale, 1));
  font-weight: 400;
  line-height: 1.45;
  letter-spacing: 0.01em;
  text-shadow: var(--orbit-shadow);
  overflow-wrap: anywhere;
}

/* The rule is drawn by the connector polyline, which also carries the
 * leader: one continuous stroke means the elbow has no seam. This element
 * keeps its place in the flow (and is the thing measured). */
.rule {
  flex: none;
  height: 1px;
  margin: 9px 0 8px;
  background: transparent;
}

.body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  color: var(--orbit-text-soft);
  font-size: calc(12px * var(--orbit-text-scale, 1));
  line-height: 1.6;
  text-shadow: var(--orbit-shadow);
  overflow-wrap: anywhere;
  scrollbar-width: none;
}

.body::-webkit-scrollbar {
  display: none;
}

.body.is-clipped {
  mask-image: linear-gradient(to bottom, #000 calc(100% - 22px), transparent);
}

/* The body renders as markdown; v-html content carries no scope attributes,
 * so nested selectors go through :deep(). */
.body :deep(p) {
  margin: 0 0 6px;
}

.body :deep(p:last-child) {
  margin-bottom: 0;
}

.body :deep(ul),
.body :deep(ol) {
  margin: 0 0 6px;
  padding-left: 18px;
}

.body :deep(li) {
  margin: 2px 0;
}

.body :deep(a) {
  color: var(--orbit-accent);
}

.body :deep(code) {
  font-size: calc(11px * var(--orbit-text-scale, 1));
}

.body :deep(pre) {
  margin: 6px 0;
  padding: 6px 8px;
  overflow-x: auto;
  border-radius: 4px;
  background: var(--orbit-fill);
}

.body :deep(blockquote) {
  margin: 6px 0;
  padding-left: 8px;
  border-left: 2px solid var(--orbit-line);
  opacity: 0.86;
}

.body :deep(table) {
  border-collapse: collapse;
}

.body :deep(th),
.body :deep(td) {
  padding: 2px 6px;
  border: 1px solid var(--orbit-line);
}

.body :deep(img) {
  max-width: 100%;
}

.body :deep(h1),
.body :deep(h2),
.body :deep(h3),
.body :deep(h4) {
  margin: 8px 0 4px;
  font-size: calc(12px * var(--orbit-text-scale, 1));
  color: var(--orbit-text);
}

.callout-enter-active,
.callout-leave-active {
  transition: opacity 0.16s ease;
}

.callout-enter-from,
.callout-leave-to {
  opacity: 0;
}
</style>
