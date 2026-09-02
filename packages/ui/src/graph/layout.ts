import type { LayoutDirection } from "../types";

/** Minimal read-only node shape the layout needs. */
export interface LayoutNode {
  id: string;
  grounds?: readonly string[];
}

/**
 * Layered DAG layout. Layers follow the grounds edges (a node sits below all
 * of its grounds); the chosen direction only maps layer/order coordinates to
 * x/y, so any future layout strategy can reuse the same node/edge geometry.
 */

export interface LaidOutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphGeometry {
  nodes: LaidOutNode[];
  /** Edges from ground (source) to grounded node (target). */
  edges: Array<{ from: LaidOutNode; to: LaidOutNode; path: string }>;
  width: number;
  height: number;
}

const NODE_WIDTH = 150;
const NODE_HEIGHT = 44;
const LAYER_GAP = 90;
const CROSS_GAP = 16;

/** Longest-path layering: roots (no grounds) are layer 0. */
function computeLayers(
  nodes: readonly LayoutNode[],
  byId: ReadonlyMap<string, LayoutNode>,
): Map<string, number> {
  const layers = new Map<string, number>();

  const depthOf = (id: string, path: Set<string>): number => {
    const cached = layers.get(id);
    if (cached !== undefined) return cached;
    const node = byId.get(id);
    if (node === undefined) return 0;
    const grounds = (node.grounds ?? []).filter((g) => byId.has(g));
    if (grounds.length === 0 || path.has(id)) {
      layers.set(id, 0);
      return 0;
    }
    path.add(id);
    let depth = 0;
    for (const ground of grounds) {
      depth = Math.max(depth, depthOf(ground, path) + 1);
    }
    path.delete(id);
    layers.set(id, depth);
    return depth;
  };

  for (const node of nodes) depthOf(node.id, new Set());
  return layers;
}

function edgePath(
  from: LaidOutNode,
  to: LaidOutNode,
  direction: LayoutDirection,
  horizontal: boolean,
): string {
  // The edge leaves the source on its flow-facing side and enters the target
  // from the opposite side, so paths never cross the node cards.
  const [x1, y1] = anchor(from, direction, horizontal, true);
  const [x2, y2] = anchor(to, direction, horizontal, false);
  if (horizontal) {
    const mid = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
  }
  const mid = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
}

/**
 * Anchor on the flow-facing side of `node` when `outgoing`, otherwise on the
 * opposite side. The flow runs from abstract to concrete: right for LR, left
 * for RL, down for TB, up for BT — so an outgoing edge leaves through the
 * flow-facing side while an incoming edge enters through the other side.
 */
function anchor(
  node: LaidOutNode,
  direction: LayoutDirection,
  horizontal: boolean,
  outgoing: boolean,
): [number, number] {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  const flowPositive = horizontal ? direction === "LR" : direction === "TB";
  const atFarSide = outgoing === flowPositive;
  if (horizontal) {
    return [atFarSide ? node.x + node.width : node.x, cy];
  }
  return [cx, atFarSide ? node.y + node.height : node.y];
}

export function layoutGraph(
  nodes: readonly LayoutNode[],
  direction: LayoutDirection,
): GraphGeometry {
  const byId = new Map<string, LayoutNode>(nodes.map((n) => [n.id, n] as const));
  const layers = computeLayers(nodes, byId);

  const horizontal = direction === "LR" || direction === "RL";
  const byLayer = new Map<number, LayoutNode[]>();
  for (const node of nodes) {
    const layer = layers.get(node.id) ?? 0;
    const bucket = byLayer.get(layer) ?? [];
    bucket.push(node);
    byLayer.set(layer, bucket);
  }
  for (const bucket of byLayer.values()) bucket.sort((a, b) => (a.id < b.id ? -1 : 1));

  const laidOut: LaidOutNode[] = [];
  for (const [layer, bucket] of byLayer) {
    for (const [index, node] of bucket.entries()) {
      // Main axis: layer progression; cross axis: order within the layer.
      const main = layer * (horizontal ? NODE_WIDTH + LAYER_GAP : NODE_HEIGHT + LAYER_GAP);
      const cross = index * (horizontal ? NODE_HEIGHT + CROSS_GAP : NODE_WIDTH + CROSS_GAP);
      const [x, y] =
        direction === "LR"
          ? [main, cross]
          : direction === "RL"
            ? [-main - NODE_WIDTH, cross]
            : direction === "TB"
              ? [cross, main]
              : [cross, -main - NODE_HEIGHT];
      laidOut.push({ id: node.id, x, y, width: NODE_WIDTH, height: NODE_HEIGHT });
    }
  }
  const byLaidOut = new Map(laidOut.map((n) => [n.id, n]));

  const edges: GraphGeometry["edges"] = [];
  for (const node of nodes) {
    const target = byLaidOut.get(node.id);
    if (target === undefined) continue;
    for (const groundId of node.grounds ?? []) {
      const source = byLaidOut.get(groundId);
      if (source !== undefined) {
        edges.push({
          from: source,
          to: target,
          path: edgePath(source, target, direction, horizontal),
        });
      }
    }
  }

  const minX = Math.min(0, ...laidOut.map((n) => n.x));
  const minY = Math.min(0, ...laidOut.map((n) => n.y));
  // Normalize into positive coordinates with padding, then measure the box
  // from the moved nodes so nothing sticks out of the viewBox.
  for (const node of laidOut) {
    node.x += -minX + 20;
    node.y += -minY + 20;
  }
  const width = Math.max(...laidOut.map((n) => n.x + n.width)) + 20;
  const height = Math.max(...laidOut.map((n) => n.y + n.height)) + 20;

  const moved = new Map(laidOut.map((n) => [n.id, n]));
  for (const edge of edges) {
    edge.from = moved.get(edge.from.id)!;
    edge.to = moved.get(edge.to.id)!;
    edge.path = edgePath(edge.from, edge.to, direction, horizontal);
  }

  return { nodes: laidOut, edges, width, height };
}
