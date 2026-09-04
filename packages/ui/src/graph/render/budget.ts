/**
 * Render budget: cost units, initial estimation, frame-time adaptation and
 * priority culling for the WebGL canvas (ui README, "渲染预算").
 *
 * Rendering scale is capped in abstract cost units rather than node counts:
 * a node that draws text costs more than a bare shape, an edge costs a
 * little. The initial budget is estimated from the viewport area times a
 * hardware capability factor; while frames render continuously (during
 * interactions and animations) the budget adapts to the measured frame
 * time, shrinking when frames run long and growing back towards the
 * estimate when they run short. A manual budget disables adaptation.
 *
 * Over-budget culling keeps, in order: the focus node, the other selected
 * nodes, the hovered node, then everything else ascending by distance to
 * the nearest selected node (ties by id, so the same working set always
 * culls the same way).
 */

/** Cost of a node that renders its label. */
export const COST_TEXT_NODE = 8;
/** Cost of a shape-only node (label hidden by the LOD rule or empty). */
export const COST_SHAPE_NODE = 2;
/** Cost of one edge. */
export const COST_EDGE = 1;

/** A node draws its label only when its on-screen height reaches this.
 * The fitted working set typically lands around scale 0.5-0.8, so the
 * threshold must stay well below the reference node height (44px). */
export const TEXT_LOD_SCREEN_H = 16;

/** Reference node footprint translating viewport area into slots. */
const REFERENCE_NODE_AREA = 150 * 44;
/** Cost units budgeted per reference slot in the initial estimate. */
const ESTIMATE_UNITS_PER_SLOT = 24;
export const MIN_BUDGET = 64;
const MAX_BUDGET = 200_000;

export interface BudgetOptions {
  /** Auto adapts to frame times; manual pins the budget to `manualBudget`. */
  mode: "auto" | "manual";
  manualBudget: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Hardware capability proxy in [0.5, 3]; logical cores are the portable signal. */
export function hardwareFactor(hardwareConcurrency: number | undefined): number {
  const cores = hardwareConcurrency ?? 8;
  return Math.min(3, Math.max(0.5, cores / 8));
}

/** Initial cost-unit budget: reference nodes fitting the viewport, with
 * headroom for edges, scaled by the hardware factor. */
export function estimateBudget(viewport: Size, factor: number): number {
  if (viewport.width <= 0 || viewport.height <= 0) return MIN_BUDGET;
  const slots = (viewport.width * viewport.height) / REFERENCE_NODE_AREA;
  return Math.round(
    Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, slots * ESTIMATE_UNITS_PER_SLOT * factor)),
  );
}

/** Frame-time targets: shrink below ~40fps, grow back above ~60fps. */
const SHRINK_MS = 25;
const GROW_MS = 12;
const EMA_ALPHA = 0.2;
/** Consecutive rendered frames before the first adjustment kicks in. */
const WARMUP_FRAMES = 8;
/** Frames between adjustments, letting the measurement settle in between. */
const ADJUST_INTERVAL_FRAMES = 30;
const MIN_MULTIPLIER = 0.05;
const SHRINK_FACTOR = 0.85;
const GROW_FACTOR = 1.08;

export interface AdaptiveBudget {
  /** The budget in cost units under the current mode and measurements. */
  current(): number;
  /** Replace mode/manual value without losing the adaptation state. */
  setOptions(options: BudgetOptions): void;
  /** Feed one continuously-rendered frame's duration in ms. */
  reportFrame(deltaMs: number): void;
  /** Re-estimate from a new viewport size (e.g. after a resize). */
  reestimate(viewport: Size): void;
}

export function createAdaptiveBudget(
  options: BudgetOptions,
  viewport: Size,
  factor: number,
): AdaptiveBudget {
  let current = { ...options };
  let estimate = estimateBudget(viewport, factor);
  let multiplier = 1;
  let ema = 1000 / 60;
  let frames = 0;
  let lastAdjustAt = 0;

  return {
    current(): number {
      if (current.mode === "manual") {
        return Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, Math.round(current.manualBudget)));
      }
      return Math.max(MIN_BUDGET, Math.round(estimate * multiplier));
    },
    setOptions(options: BudgetOptions): void {
      current = { ...options };
    },
    reportFrame(deltaMs: number): void {
      if (current.mode === "manual") return;
      ema += (deltaMs - ema) * EMA_ALPHA;
      frames++;
      if (frames < WARMUP_FRAMES) return;
      if (lastAdjustAt !== 0 && frames - lastAdjustAt < ADJUST_INTERVAL_FRAMES) return;
      if (ema > SHRINK_MS && multiplier > MIN_MULTIPLIER) {
        multiplier = Math.max(MIN_MULTIPLIER, multiplier * SHRINK_FACTOR);
        lastAdjustAt = frames;
      } else if (ema < GROW_MS && multiplier < 1) {
        multiplier = Math.min(1, multiplier * GROW_FACTOR);
        lastAdjustAt = frames;
      }
    },
    reestimate(viewport: Size): void {
      estimate = estimateBudget(viewport, factor);
    },
  };
}

/** Render priority classes; lower survives culling first. */
export const CULL_FOCUS = 0;
export const CULL_SELECTED = 1;
export const CULL_HOVERED = 2;
export const CULL_OTHER = 3;

export interface CullEntry {
  id: string;
  /** Node cost under the current LOD. */
  cost: number;
  /** Priority class (see CULL_*); lower survives first. */
  cls: number;
  /** Distance to the nearest selected node; orders within a class. */
  distance: number;
}

export interface CullEdge {
  fromId: string;
  toId: string;
}

export interface CullResult {
  admitted: Set<string>;
  /** Edges that render, as "fromId\0toId" keys: both endpoints admitted and
   * the budget allowed their cost. */
  edges: Set<string>;
  /** True when nodes or edges were dropped. */
  culled: boolean;
}

/**
 * Greedy admission in priority order. A node is admitted together with the
 * costs of the edges it lights up (edges whose other endpoint is already
 * admitted), so edges consume budget exactly like the spec's "edges cost a
 * little": a node whose edges would overflow the budget is skipped in favor
 * of cheaper, lower-priority ones.
 */
export function cullByBudget(
  entries: readonly CullEntry[],
  edges: readonly CullEdge[],
  budget: number,
): CullResult {
  const order = [...entries].sort((a, b) =>
    a.cls !== b.cls
      ? a.cls - b.cls
      : a.distance !== b.distance
        ? a.distance - b.distance
        : a.id < b.id
          ? -1
          : 1,
  );

  const edgeKeys = new Map<string, CullEdge>();
  const byNode = new Map<string, string[]>();
  const keyOf = (edge: CullEdge): string => `${edge.fromId}\u0000${edge.toId}`;
  for (const edge of edges) {
    const key = keyOf(edge);
    edgeKeys.set(key, edge);
    for (const endpoint of [edge.fromId, edge.toId]) {
      const list = byNode.get(endpoint);
      if (list) list.push(key);
      else byNode.set(endpoint, [key]);
    }
  }

  const admitted = new Set<string>();
  const enabled = new Set<string>();
  let spent = 0;
  for (const entry of order) {
    let cost = entry.cost;
    for (const key of byNode.get(entry.id) ?? []) {
      if (enabled.has(key)) continue;
      const edge = edgeKeys.get(key)!;
      const other = entry.id === edge.fromId ? edge.toId : edge.fromId;
      if (admitted.has(other)) cost += COST_EDGE;
    }
    if (spent + cost > budget) continue;
    spent += cost;
    admitted.add(entry.id);
    for (const key of byNode.get(entry.id) ?? []) {
      const edge = edgeKeys.get(key)!;
      const other = entry.id === edge.fromId ? edge.toId : edge.fromId;
      if (admitted.has(other)) enabled.add(key);
    }
  }

  return {
    admitted,
    edges: enabled,
    culled: admitted.size < entries.length || enabled.size < edges.length,
  };
}
