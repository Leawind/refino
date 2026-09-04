import { layeredStrategy } from "./engine";
import { forceStrategy } from "./force";
import type { LayoutMode, LayoutNode, LayoutOptions, LayoutSession, LayoutStrategy } from "./types";

/**
 * Layout strategy registry: the single entry point the canvas uses to
 * start a layout. Strategies register here; nothing above this module
 * imports a concrete algorithm.
 */

const strategies: Record<LayoutMode, LayoutStrategy> = {
  layered: layeredStrategy,
  force: forceStrategy,
};

/** All selectable layout modes, registry order. */
export const layoutModes: readonly LayoutMode[] = Object.keys(strategies) as LayoutMode[];

export function layoutStrategy(mode: LayoutMode): LayoutStrategy {
  return strategies[mode];
}

/** Starts a layout session of `mode` over exactly the given node set. */
export function createLayoutSession(
  mode: LayoutMode,
  nodes: readonly LayoutNode[],
  options: LayoutOptions,
): LayoutSession {
  return strategies[mode].createSession(nodes, options);
}
