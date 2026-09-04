import type { LayoutDirection } from "../../types";

/**
 * Session-based layout contract (ui README, "布局").
 *
 * A layout strategy owns one algorithm; a session is one live layout of
 * exactly the node set it was created with. Snapshot layouts (layered)
 * finish immediately; converging layouts (force-directed) keep stepping
 * until settled. The canvas drives sessions from its render loop and only
 * consumes geometry, so strategies stay free of Vue and renderer concerns.
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
export type LayoutMode = "layered" | "force";

/** Inputs a strategy may use; each strategy picks what applies to it
 * (direction matters for layered, is ignored by force-directed). */
export interface LayoutOptions {
  direction: LayoutDirection;
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
}

/** A layout algorithm behind a `LayoutMode`. */
export interface LayoutStrategy {
  readonly id: LayoutMode;
  createSession(nodes: readonly LayoutNode[], options: LayoutOptions): LayoutSession;
}
