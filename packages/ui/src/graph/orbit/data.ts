import type { NodeLite } from "../../types";
import { structureSignature } from "../layout/structure";
import { hashAngle, layoutOrbit } from "./layout";
import type { OrbitSceneEdge, OrbitSceneNode, OrbitSceneSatellite } from "./scene";

/** One frame of orbit data: decision positions, the satellite rings of their
 * premises, the grounds edges between decisions and the structure signature
 * that decides when a rebuild is due. */
export interface OrbitSceneData {
  nodes: OrbitSceneNode[];
  satellites: OrbitSceneSatellite[];
  edges: OrbitSceneEdge[];
  signature: string;
}

/** Base ring radius of a premise around a decision and around the virtual
 * root. Every extra satellite of the same host takes a slightly wider ring,
 * so the premise tracks never coincide. */
export const DECISION_SATELLITE_RADIUS = 0.68;
export const ROOT_SATELLITE_RADIUS = 1.1;
/** Radial gap between the staggered rings of one host. */
const SATELLITE_RADIUS_STEP = 0.16;

interface OrbitPoint {
  x: number;
  y: number;
  z: number;
}

function normalize(point: OrbitPoint): OrbitPoint {
  const size = Math.hypot(point.x, point.y, point.z);
  return size < 1e-9
    ? { x: 0, y: 1, z: 0 }
    : { x: point.x / size, y: point.y / size, z: point.z / size };
}

function cross(left: OrbitPoint, right: OrbitPoint): OrbitPoint {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

/** Orthonormal basis of a satellite ring, tilted deterministically by the
 * host id: the same host always gets the same plane. */
export function orbitRingBasis(seed: string): { axisA: OrbitPoint; axisB: OrbitPoint } {
  const normal = normalize({
    x: Math.sin(hashAngle(`${seed}:x`)),
    y: Math.cos(hashAngle(`${seed}:y`)),
    z: Math.sin(hashAngle(`${seed}:z`)),
  });
  const reference = Math.abs(normal.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const axisA = normalize(cross(normal, reference));
  return { axisA, axisB: cross(normal, axisA) };
}

/** Project the displayed working set into the orbit scene (ui DESIGN.md,
 * "三维视图"): decisions fill the lineage shells, each premise becomes a
 * satellite ring around every displayed decision that grounds on it, and a
 * premise nobody references orbits the virtual root instead. */
export function buildOrbitScene(displayed: readonly NodeLite[]): OrbitSceneData {
  const decisions = displayed.filter((node) => node.type === "decision");
  const premises = displayed
    .filter((node) => node.type === "premise")
    .sort((left, right) => left.id.localeCompare(right.id));
  const layout = layoutOrbit(decisions.map((node) => ({ id: node.id, grounds: node.grounds })));

  const nodes: OrbitSceneNode[] = [];
  for (const decision of decisions) {
    const point = layout.positions.get(decision.id);
    if (point === undefined) continue;
    nodes.push({
      id: decision.id,
      x: point.x,
      y: point.y,
      z: point.z,
      depth: layout.levels.get(decision.id) ?? 1,
      root: (layout.parents.get(decision.id) ?? null) === null,
    });
  }

  const knownDecisions = new Set(decisions.map((node) => node.id));
  const premiseIds = new Set(premises.map((node) => node.id));
  const edges: OrbitSceneEdge[] = [];
  for (const decision of decisions) {
    for (const ground of decision.grounds ?? []) {
      if (!knownDecisions.has(ground)) continue;
      edges.push({
        from: ground,
        to: decision.id,
        primary: layout.parents.get(decision.id) === ground,
      });
    }
  }

  // A premise joins the ring of every displayed decision that grounds on it;
  // one nobody references joins the root ring.
  const consumers = new Map<string, string[]>();
  for (const decision of decisions) {
    for (const ground of decision.grounds ?? []) {
      if (!premiseIds.has(ground)) continue;
      const list = consumers.get(ground) ?? [];
      list.push(decision.id);
      consumers.set(ground, list);
    }
  }
  for (const list of consumers.values()) list.sort();

  const groups = new Map<string | null, string[]>();
  for (const premise of premises) {
    const hosts = consumers.get(premise.id) ?? [null];
    for (const host of hosts) {
      const list = groups.get(host) ?? [];
      list.push(premise.id);
      groups.set(host, list);
    }
  }

  const satellites: OrbitSceneSatellite[] = [];
  for (const [host, members] of groups) {
    members.sort((left, right) => left.localeCompare(right));
    const seed = host ?? "root";
    const offset = hashAngle(seed);
    const radius = host === null ? ROOT_SATELLITE_RADIUS : DECISION_SATELLITE_RADIUS;
    members.forEach((id, index) => {
      // Each copy tilts its own plane: premises never share one flat ring.
      const { axisA, axisB } = orbitRingBasis(`${seed}:${id}`);
      satellites.push({
        key: `${id}@${host ?? "root"}`,
        id,
        host,
        radius: radius + index * SATELLITE_RADIUS_STEP,
        phase: offset + (index * Math.PI * 2) / members.length,
        axisA,
        axisB,
      });
    });
  }
  satellites.sort((left, right) => left.key.localeCompare(right.key));

  return { nodes, satellites, edges, signature: structureSignature(displayed) };
}
