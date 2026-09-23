import type { LayoutDirection } from "../../types";

/**
 * Session-based layout contract (ui README, "布局").
 *
 * A layout strategy owns one algorithm; a session is one live layout of
 * exactly the node set it was created with. Snapshot layouts (layered)
 * finish immediately; converging layouts (force-directed, rail) keep
 * stepping until settled. The canvas drives sessions from its render loop
 * and only consumes geometry, so strategies stay free of Vue and renderer
 * concerns.
 */

/** Minimal read-only node shape any layout needs. */
export interface LayoutNode {
  id: string;
  grounds?: readonly string[];
}

/** Mapped node geometry in virtual space. */
export interface LaidOutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Selectable layout algorithms. */
export type LayoutMode = "layered" | "force" | "rail";

/** Tuning coefficients only the force-directed strategy reads. Every
 * field has a built-in default; the canvas config overrides them. */
export interface ForceTuning {
  /** Constant downstream acceleration every node feels along the
   * display direction (the load the anchored spring chain hangs against). */
  gravity: number;
  /** Fraction of a body's velocity bled off each tick (friction). */
  friction: number;
  /** Pair repulsion magnitude: the k in the k/d falloff. */
  repulsion: number;
  /** Spring stiffness scale: each spring gets this divided by the node
   * count of the layer its downstream end sits in. */
  spring: number;
}

/** Inputs a strategy may use; each strategy picks what applies to it
 * (direction signs the main axis in both strategies). */
export interface LayoutOptions {
  direction: LayoutDirection;
  /** Common spacing between adjacent grounds layers, in virtual units,
   * added to the card dimension along the main axis. Layered maps one
   * pitch per layer; force-directed springs rest at one pitch per layer
   * span. Absent keeps the reference spacing. */
  layerGap?: number;
  /** Shared node card geometry in virtual units; every strategy spaces and
   * stamps its output with it. Absent means the reference card size. */
  nodeSize?: { width: number; height: number };
  /** Force-directed tuning; only the force strategy reads it. Absent
   * keeps the built-in coefficients. */
  force?: ForceTuning;
  /** Coordinates of the previous session's nodes, offered as a seed. The
   * layered strategy ignores it (always lays out from scratch); the
   * force-directed strategy carries known nodes over — plus its virtual
   * root's position, stored under the root's internal id — and relaxes
   * from them; the rail strategy carries the cross-axis coordinate only
   * (the main axis is re-derived from the fresh layering), so working-set
   * changes nudge the layout instead of re-swimming it. */
  seed?: ReadonlyMap<string, { x: number; y: number }>;
}

/** One live layout of a fixed node set, advanced per animation frame. */
export interface LayoutSession {
  /** Whether further `step` calls still move nodes (animation running). */
  readonly animating: boolean;
  /** Advance by `dtMs`, returning the current geometry; a settled session
   * returns its geometry unchanged. */
  step(dtMs: number): readonly LaidOutNode[];
  /** Current geometry without advancing. */
  positions(): readonly LaidOutNode[];
  dispose(): void;
  /** Pointer-drag support (converging layouts): pins the node at the given
   * virtual position while dragged — the node follows the pointer and its
   * neighbourhood keeps relaxing — and releases it back to the forces. */
  fix?(id: string, x: number, y: number): void;
  release?(id: string): void;
  /** The layout-internal anchor node (force layouts): the pinned virtual
   * root the graph hangs from. Always maintained by the physics, exposed
   * for display only — rendering it is the canvas's choice, and it must
   * never take part in interaction (pick, drag, selection). */
  anchorNode?(): LaidOutNode | null;
  /** The anchor's links to the working set's roots, as id pairs. */
  anchorEdges?(): readonly Readonly<{ source: string; target: string }>[];
}

/** A layout algorithm behind a `LayoutMode`. */
export interface LayoutStrategy {
  readonly id: LayoutMode;
  createSession(nodes: readonly LayoutNode[], options: LayoutOptions): LayoutSession;
}
