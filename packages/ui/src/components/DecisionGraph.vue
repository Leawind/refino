<script setup lang="ts">
// Center canvas: the working set rendered by the WebGL2 batch renderer
// (README, "画布"): nodes, edges and labels draw on the GPU with the render
// budget culling over-budget parts; floating controls stay DOM. Clicking a
// node selects it, shift+click range-selects (replacing the selection),
// right-click toggles, double click opens the detail bar, hovering pulls in
// the node's direct grounds.
// The layout is recomputed from scratch on every working-set change; the
// camera keeps the focus node at a stable screen position — clicking a node
// never displaces it — flying only for an off-screen or newly joining
// focus, and re-fitting on direction flips.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { injectRequired } from "../context";
import { peekHide, peekMove } from "../peek";
import { storeKey } from "../store";
import { workspaceKey } from "../workspace";

const store = injectRequired(storeKey, "store");
const workspace = injectRequired(workspaceKey, "workspace");
import { createLayoutSession } from "../graph/layout/registry";
import { structureSignature } from "../graph/layout/structure";
import type { LaidOutNode, LayoutSession } from "../graph/layout/types";
import type { LayoutMode } from "../graph/layout/types";
import {
  CULL_FOCUS,
  CULL_HOVERED,
  CULL_OTHER,
  CULL_SELECTED,
  createAdaptiveBudget,
  hardwareFactor,
} from "../graph/render/budget";
import type { AdaptiveBudget } from "../graph/render/budget";
import { GraphRenderer, readThemeColors } from "../graph/render/renderer";
import type { RenderEdgeInput, RenderNodeInput, SceneInput } from "../graph/render/renderer";
import type { LayoutDirection } from "../types";

const props = defineProps<{ direction: LayoutDirection; layoutMode: LayoutMode }>();

const emit = defineEmits<{ renderCulled: [culled: boolean] }>();

const { t } = useI18n();

const canvasEl = ref<HTMLCanvasElement | null>(null);
const glFailed = ref(false);
let renderer: GraphRenderer | null = null;
let budget: AdaptiveBudget | null = null;

// The layout session is (re)created from the displayed subgraph whenever
// it, the mode or the direction changes; converging sessions step from a
// requestAnimationFrame loop until settled, snapshot layouts finish at
// creation. The camera keeps the focus node in place.
const layout = ref<LaidOutNode[]>([]);
// The force layout's virtual root, kept alongside the layout: its position
// advances with every step like any node, but it renders only when the
// canvas config asks for it, and only in force mode. The anchor edges are
// fixed per session (the anchor links the working set's roots).
const anchor = ref<LaidOutNode | null>(null);
const anchorEdges = ref<readonly Readonly<{ source: string; target: string }>[]>([]);
let session: LayoutSession | null = null;
let rafId = 0;
let lastFrame = 0;
/** Structure of the live session: displayed ids + grounds edges, mode,
 * direction, card size and the layout spacing/tuning inputs. A selection
 * change that alters none of them must not restart (and wobble) the
 * session. */
let lastStructure: {
  signature: string;
  mode: LayoutMode;
  direction: LayoutDirection;
  nodeWidth: number;
  nodeHeight: number;
  layerGap: number;
  forceGravity: number;
  forceFriction: number;
  forceRepulsion: number;
  forceSpring: number;
} | null = null;

function stopSession(): void {
  if (rafId !== 0) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  session?.dispose();
  session = null;
}

function startSession(): void {
  const mode = props.layoutMode;
  const direction = props.direction;
  const displayed = workspace.displayed.value;
  const signature = structureSignature(displayed);
  const config = workspace.state.config;
  const nodeWidth = config.nodeWidth;
  const nodeHeight = config.nodeHeight;
  const layerGap = config.layerGap;
  const forceGravity = config.forceGravity;
  const forceFriction = config.forceFriction;
  const forceRepulsion = config.forceRepulsion;
  const forceSpring = config.forceSpring;
  const sameOrientation =
    session !== null &&
    lastStructure !== null &&
    lastStructure.mode === mode &&
    lastStructure.direction === direction;
  // A selection change that alters neither the node set, the edges, the
  // card size nor the layout tuning keeps the settled session: restarting
  // it would only wobble.
  if (
    sameOrientation &&
    lastStructure!.signature === signature &&
    lastStructure!.nodeWidth === nodeWidth &&
    lastStructure!.nodeHeight === nodeHeight &&
    lastStructure!.layerGap === layerGap &&
    lastStructure!.forceGravity === forceGravity &&
    lastStructure!.forceFriction === forceFriction &&
    lastStructure!.forceRepulsion === forceRepulsion &&
    lastStructure!.forceSpring === forceSpring
  )
    return;
  // Hand the outgoing session's coordinates to the next one before
  // disposing it, but only when mode and direction are unchanged: the
  // force strategy carries known nodes over and relaxes from them (a
  // working-set change must not re-swim the graph), while a mode or
  // direction switch means a fundamentally different layout and gets a
  // full relaxation. The layered strategy ignores the seed either way.
  // The anchor's position rides along in the seed map (under its internal
  // id) so a reseeded session hangs from exactly where the last one did
  // instead of sliding downstream.
  let seedMap: Map<string, { x: number; y: number }> | undefined;
  if (session !== null && sameOrientation) {
    seedMap = new Map(session.positions().map((n) => [n.id, { x: n.x, y: n.y }] as const));
    const anchorNode = session.anchorNode?.();
    if (anchorNode != null) {
      seedMap.set(anchorNode.id, { x: anchorNode.x, y: anchorNode.y });
    }
  }
  lastStructure = {
    signature,
    mode,
    direction,
    nodeWidth,
    nodeHeight,
    layerGap,
    forceGravity,
    forceFriction,
    forceRepulsion,
    forceSpring,
  };
  stopSession();
  // Layouts only see the placement-relevant shape of a node; the premise
  // flag steers the display-layer placement (just upstream of the
  // decisions a premise supports).
  session = createLayoutSession(
    mode,
    displayed.map((lite) => ({
      id: lite.id,
      grounds: lite.grounds,
      premise: lite.type === "premise",
    })),
    {
      direction,
      nodeSize: { width: nodeWidth, height: nodeHeight },
      layerGap,
      force:
        mode === "force"
          ? {
              gravity: forceGravity,
              friction: forceFriction,
              repulsion: forceRepulsion,
              spring: forceSpring,
            }
          : undefined,
      seed: seedMap,
    },
  );
  layout.value = [...session.positions()];
  anchor.value = session.anchorNode?.() ?? null;
  anchorEdges.value = session.anchorEdges?.() ?? [];
  runSession();
}

/** Drives a session's relaxation from the rAF loop; a drag on a settled
 * session revives it through here. */
function runSession(): void {
  if (session === null || rafId !== 0 || !session.animating) return;
  lastFrame = performance.now();
  const tick = (now: number): void => {
    const current = session;
    if (current === null) return;
    layout.value = [...current.step(now - lastFrame)];
    anchor.value = current.anchorNode?.() ?? null;
    lastFrame = now;
    if (current.animating) rafId = requestAnimationFrame(tick);
    else rafId = 0;
  };
  rafId = requestAnimationFrame(tick);
}

watch(
  () => [workspace.displayed.value, props.direction, props.layoutMode] as const,
  () => startSession(),
  { immediate: true },
);

const byId = computed(() => new Map(workspace.displayed.value.map((n) => [n.id, n] as const)));

/** Display list with render priority classes and per-node styling flags. */
const scene = computed<SceneInput>(() => {
  const { selection, focusId, hoveredId } = workspace.state;
  const selectionSet = new Set(selection);
  const positions = new Map(layout.value.map((n) => [n.id, n] as const));
  // The card size is a canvas config: the scene reads it directly so a
  // resize takes effect immediately, without waiting for a layout restart.
  const cardWidth = workspace.state.config.nodeWidth;
  const cardHeight = workspace.state.config.nodeHeight;
  const distanceToSelection = (node: { x: number; y: number }) => {
    const cx = node.x + cardWidth / 2;
    const cy = node.y + cardHeight / 2;
    let best = Infinity;
    for (const id of selectionSet) {
      const center = positions.get(id);
      if (center === undefined) continue;
      best = Math.min(
        best,
        Math.hypot(cx - (center.x + cardWidth / 2), cy - (center.y + cardHeight / 2)),
      );
    }
    return best;
  };

  const nodes: RenderNodeInput[] = [];
  const displayedIds = new Set<string>();
  for (const lite of workspace.displayed.value) {
    const node = positions.get(lite.id);
    if (node === undefined) continue;
    displayedIds.add(lite.id);
    nodes.push({
      id: lite.id,
      x: node.x,
      y: node.y,
      width: cardWidth,
      height: cardHeight,
      label: lite.summary === "" ? t("node.untitled") : lite.summary,
      selected: selectionSet.has(lite.id),
      focus: lite.id === focusId,
      hovered: lite.id === hoveredId,
      premise: lite.type === "premise",
      cls:
        lite.id === focusId
          ? CULL_FOCUS
          : selectionSet.has(lite.id)
            ? CULL_SELECTED
            : lite.id === hoveredId
              ? CULL_HOVERED
              : CULL_OTHER,
      distance: distanceToSelection(node),
    });
  }
  const edges: RenderEdgeInput[] = [];
  for (const lite of workspace.displayed.value) {
    if (lite.type !== "decision") continue;
    for (const ground of lite.grounds ?? []) {
      if (!displayedIds.has(ground)) continue;
      edges.push({
        fromId: ground,
        toId: lite.id,
        // Hovered decisions highlight their direct grounds; edges between
        // two selected nodes share the emphasized style (DESIGN.md).
        emphasized:
          lite.id === hoveredId || (selectionSet.has(ground) && selectionSet.has(lite.id)),
        weak: byId.value.get(ground)?.type === "premise",
      });
    }
  }
  // The force layout's virtual root renders on request (ui DESIGN.md,
  // "力导向"): weakened capsule like a premise, but display-only — the
  // renderer never picks it, so it cannot be hovered, dragged or selected,
  // and it stays out of the camera bounds (positions() excludes it).
  if (props.layoutMode === "force" && workspace.state.config.showVirtualRoot && anchor.value) {
    const node = anchor.value;
    nodes.push({
      id: node.id,
      x: node.x,
      y: node.y,
      width: cardWidth,
      height: cardHeight,
      label: t("canvas.virtualRoot"),
      selected: false,
      focus: false,
      hovered: false,
      premise: true,
      virtual: true,
      cls: CULL_OTHER,
      distance: Infinity,
    });
    for (const edge of anchorEdges.value) {
      if (!displayedIds.has(edge.target)) continue;
      edges.push({ fromId: edge.source, toId: edge.target, emphasized: false, weak: true });
    }
  }
  return {
    nodes,
    edges,
    focusId,
    // Snapshot layouts pin the focus through relayouts; converging
    // layouts (force, rail) leave the viewport entirely to the user —
    // the layout itself moves the nodes, and camera reactions would only
    // add noise (ui DESIGN.md, "视口").
    focusFollow: props.layoutMode === "layered" ? ("pin" as const) : ("none" as const),
  };
});

function syncBudget(): void {
  budget?.setOptions({
    mode: workspace.state.config.budgetMode,
    manualBudget: workspace.state.config.budgetManual,
  });
  renderer?.requestRender();
}

/** Node dragging (converging layouts): the dragged node is pinned to the
 * pointer (on the rail layout, projected onto its layer line) while the
 * neighbourhood relaxes around it, and released back to the forces on
 * drop. */
function dragNode(id: string, x: number, y: number, phase: "drag" | "end"): void {
  if (phase === "drag") session?.fix?.(id, x, y);
  else session?.release?.(id);
  // A drag revives a settled session: make sure its frame loop runs.
  runSession();
}

function ensureRenderer(): void {
  const canvas = canvasEl.value;
  if (canvas === null || renderer !== null) return;
  budget = createAdaptiveBudget(
    {
      mode: workspace.state.config.budgetMode,
      manualBudget: workspace.state.config.budgetManual,
    },
    { width: canvas.clientWidth, height: canvas.clientHeight },
    hardwareFactor(navigator.hardwareConcurrency),
    workspace.state.config.nodeWidth * workspace.state.config.nodeHeight,
  );
  renderer = GraphRenderer.create(canvas, budget);
  if (renderer === null) {
    glFailed.value = true;
    return;
  }
  renderer.onFrameEnd = (info) => emit("renderCulled", info.culled);
  renderer.setZoomAnchor(workspace.state.config.zoomAnchor);
  renderer.setMaxScale(workspace.state.config.zoomMax);
  renderer.setTextScale(workspace.state.config.textScale);
  renderer.setNodeArea(workspace.state.config.nodeWidth * workspace.state.config.nodeHeight);
  renderer.setTheme(readThemeColors());
  renderer.setNodeDragHandler(props.layoutMode === "layered" ? null : dragNode);
  renderer.setScene(scene.value);
}

// Node dragging follows the layout mode: only converging layouts have
// nodes that react to being moved.
watch(
  () => props.layoutMode,
  (mode) => renderer?.setNodeDragHandler(mode === "layered" ? null : dragNode),
);

onMounted(ensureRenderer);

watch(scene, (value) => renderer?.setScene(value));
// setScene keeps the focus placed (README: 相机随焦点). Direction flips
// re-fit the whole working set.
watch(
  () => props.direction,
  () => renderer?.fitToContent(),
);
watch(
  () => [workspace.state.config.zoomAnchor, workspace.state.config.zoomMax] as const,
  ([anchor, max]) => {
    renderer?.setZoomAnchor(anchor);
    renderer?.setMaxScale(max);
    renderer?.requestRender();
  },
);
watch(
  () => workspace.state.config.textScale,
  (scale) => renderer?.setTextScale(scale),
);
// Card-size, layer-gap and force-tuning changes restart the layout once
// the slider settles (layered recomputes; force reheats from the current
// coordinates), so spacing catches up without re-swimming on every tick.
let layoutRestart: ReturnType<typeof setTimeout> | undefined;
watch(
  () =>
    [
      workspace.state.config.nodeWidth,
      workspace.state.config.nodeHeight,
      workspace.state.config.layerGap,
      workspace.state.config.forceGravity,
      workspace.state.config.forceFriction,
      workspace.state.config.forceRepulsion,
      workspace.state.config.forceSpring,
    ] as const,
  ([width, height]) => {
    renderer?.setNodeArea(width * height);
    if (layoutRestart !== undefined) clearTimeout(layoutRestart);
    layoutRestart = setTimeout(() => {
      layoutRestart = undefined;
      startSession();
    }, 200);
  },
);
watch(
  () => store.state.theme,
  () => renderer?.setTheme(readThemeColors()),
);
watch(
  () => [workspace.state.config.budgetMode, workspace.state.config.budgetManual] as const,
  () => syncBudget(),
);

onBeforeUnmount(() => {
  if (layoutRestart !== undefined) clearTimeout(layoutRestart);
  stopSession();
  renderer?.dispose();
  renderer = null;
  budget = null;
});

function pickAt(event: MouseEvent): string | null {
  const canvas = canvasEl.value;
  if (canvas === null || renderer === null) return null;
  const rect = canvas.getBoundingClientRect();
  return renderer.pick(event.clientX - rect.left, event.clientY - rect.top);
}

function onClick(event: MouseEvent): void {
  // A left press that moved beyond the click slop was a pan, not a click.
  if (renderer?.clickSuppressed === true) return;
  const id = pickAt(event);
  if (id === null) return;
  const lite = byId.value.get(id);
  if (lite === undefined) return;
  if (event.shiftKey) void workspace.rangeSelect(lite);
  else workspace.select(lite);
}

function onContextMenu(event: MouseEvent): void {
  // Right click toggles the node's membership; the browser menu stays
  // suppressed on the canvas (README, "交互").
  event.preventDefault();
  const id = pickAt(event);
  if (id === null) return;
  const lite = byId.value.get(id);
  if (lite !== undefined) workspace.toggle(lite);
}

function onDoubleClick(event: MouseEvent): void {
  const id = pickAt(event);
  if (id !== null) store.openDetail(id);
}

let hoveredNode: string | null = null;

function onMouseMove(event: MouseEvent): void {
  // While panning, hover follows the grab — freeze it instead of lighting
  // up whatever slides under the cursor, and drop the peek.
  if (renderer?.dragging === true) {
    if (hoveredNode !== null) peekHide(hoveredNode);
    return;
  }
  const id = pickAt(event);
  if (id === hoveredNode) {
    if (id !== null) peekMove(id, event.clientX, event.clientY);
    return;
  }
  if (hoveredNode !== null) peekHide(hoveredNode);
  hoveredNode = id;
  if (id === null) workspace.unhover();
  else {
    workspace.hover(id);
    peekMove(id, event.clientX, event.clientY);
  }
  if (canvasEl.value !== null) canvasEl.value.style.cursor = id === null ? "default" : "pointer";
}

function onMouseLeave(): void {
  if (hoveredNode !== null) peekHide(hoveredNode);
  hoveredNode = null;
  workspace.unhover();
}
</script>

<template>
  <div class="canvas">
    <canvas
      ref="canvasEl"
      class="gl"
      @click="onClick"
      @contextmenu="onContextMenu"
      @dblclick="onDoubleClick"
      @mousemove="onMouseMove"
      @mouseleave="onMouseLeave"
    />
    <p v-if="glFailed" class="empty">{{ t("canvas.glUnavailable") }}</p>
  </div>
</template>

<style scoped>
.canvas {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  user-select: none;
  /* The canvas surface sits a step below the panels and the opaque node
   * cards drawn on it (token drives the WebGL palette too). */
  background: var(--refino-canvas-bg);
}

.gl {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}

.empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  margin: 0;
  opacity: 0.5;
  pointer-events: none;
}
</style>
