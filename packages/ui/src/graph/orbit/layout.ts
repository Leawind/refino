/**
 * Radial placement for the orbit view (ui DESIGN.md, "三维视图"): the virtual
 * root stays at the origin, lineage depth becomes a concentric shell, and
 * each shell spreads its decisions evenly with a Fibonacci sphere.
 *
 * A decision starts from a direction inherited from its genealogy parent
 * (root decisions spread over the whole sphere, a lone child continues
 * almost straight out), then takes the free slot of its shell closest to
 * that direction. Edges therefore run between neighbouring sectors instead
 * of criss-crossing the whole ball, while every shell still covers the
 * sphere evenly.
 *
 * Premises are not part of this layout: they are satellites of the decisions
 * they ground and orbit them in the scene.
 *
 * Deterministic by construction: ids break every tie, so the same working
 * set always yields the same layout.
 */

export interface OrbitNodeInput {
  id: string;
  grounds?: readonly string[];
}

export interface OrbitPoint {
  x: number;
  y: number;
  z: number;
}

export interface OrbitLayout {
  /** Decision positions; the virtual root sits at (0, 0, 0) and is not part
   * of the map. */
  positions: Map<string, OrbitPoint>;
  /** Radial distance of the bounding sphere around the origin. */
  radius: number;
  /** Lineage depth per decision (1 = a root decision). */
  levels: Map<string, number>;
  /** Genealogy parent per decision: the deepest decision ground. Null for
   * root decisions. */
  parents: Map<string, string | null>;
}

/** Visual radii, in world units: a node is a star, the root only a small
 * mark at the origin. Both feed the camera bounds and picking. */
export const ORBIT_STAR_RADIUS = 0.8;
export const ORBIT_ROOT_STAR_RADIUS = 1.1;

/** Radial distance of one lineage generation: depth is read as distance
 * from the core, so every step must stay visible. */
const LEVEL_STEP = 3;
/** Smallest first-shell radius: it keeps lineage stars clear of the root. */
const MIN_SHELL = 5.5;
/** Never place a shell closer than this to the previous one. */
const MIN_SHELL_GAP = 1.4;
/** Shell surface reserved per node when a crowded shell needs to grow. */
const SHELL_AREA_PER_NODE = 3.6;
/** Air kept between the stars and the fit sphere's surface. */
const FIT_CLEARANCE = 0.6;
/** Golden angle: the step of the sunflower direction distribution. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function normalize(point: OrbitPoint): OrbitPoint {
  const size = Math.hypot(point.x, point.y, point.z);
  return size < 1e-9 ? { x: 0, y: 0, z: 1 } : scale(point, 1 / size);
}

function cross(left: OrbitPoint, right: OrbitPoint): OrbitPoint {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function add(left: OrbitPoint, right: OrbitPoint): OrbitPoint {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function scale(point: OrbitPoint, factor: number): OrbitPoint {
  return { x: point.x * factor, y: point.y * factor, z: point.z * factor };
}

/** Deterministic pseudo-random angle in [0, 2π) derived from an id. */
export function hashAngle(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 0xffffffff) * Math.PI * 2;
}

/** Evenly spread directions on the unit sphere (Fibonacci sphere). */
function fibonacciDirections(count: number, rotation: number): OrbitPoint[] {
  const directions: OrbitPoint[] = [];
  for (let index = 0; index < count; index++) {
    const y = count === 1 ? 0 : 1 - ((index + 0.5) * 2) / count;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const angle = GOLDEN_ANGLE * index + rotation;
    directions.push({ x: Math.cos(angle) * ring, y, z: Math.sin(angle) * ring });
  }
  return directions;
}

/** Preferred direction of the `index`-th of `count` children: the parent
 * direction tilted onto its own meridian. A lone child continues nearly
 * straight; siblings fan across a cone that widens with their count. */
function childDirection(
  parent: OrbitPoint,
  index: number,
  count: number,
  seed: string,
): OrbitPoint {
  const reference = Math.abs(parent.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const tangent = normalize(cross(parent, reference));
  const bitangent = cross(parent, tangent);
  const spread = count === 1 ? 0.12 : Math.min(0.65, 0.32 + 0.08 * Math.log2(count));
  const tilt = spread * Math.sqrt((index + 0.5) / Math.max(1, count));
  const spin = GOLDEN_ANGLE * (index + 1) + hashAngle(seed);
  const outward = add(scale(tangent, Math.cos(spin)), scale(bitangent, Math.sin(spin)));
  return normalize(add(scale(parent, Math.cos(tilt)), scale(outward, Math.sin(tilt))));
}

/** Decision lineage depths; a decision's depth is one past its deepest
 * decision ground, root decisions sit at depth 1. */
function decisionLevels(index: Map<string, OrbitNodeInput>): Map<string, number> {
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  const level = (id: string): number => {
    const cached = levels.get(id);
    if (cached !== undefined) return cached;
    const node = index.get(id);
    if (node === undefined) return 0;
    // Storage rejects cycles; a broken graph still must not hang the layout.
    if (visiting.has(id)) return 1;
    visiting.add(id);
    let value = 1;
    for (const groundId of node.grounds ?? []) {
      if (!index.has(groundId)) continue;
      value = Math.max(value, level(groundId) + 1);
    }
    visiting.delete(id);
    levels.set(id, value);
    return value;
  };
  for (const id of index.keys()) level(id);
  return levels;
}

/** Place the decisions of the working set in 3D. */
export function layoutOrbit(inputs: readonly OrbitNodeInput[]): OrbitLayout {
  const index = new Map<string, OrbitNodeInput>();
  for (const input of inputs) index.set(input.id, input);
  const ids = [...index.keys()].sort();

  const decisionLevel = decisionLevels(index);

  // Genealogy tree: a decision hangs from its deepest decision ground. Ids
  // break ties.
  const parentOf = new Map<string, string | null>();
  for (const id of ids) {
    let parent: string | null = null;
    let parentLevel = -1;
    for (const groundId of index.get(id)!.grounds ?? []) {
      if (!index.has(groundId)) continue;
      const groundLevel = decisionLevel.get(groundId) ?? 1;
      if (
        groundLevel > parentLevel ||
        (groundLevel === parentLevel && (parent === null || groundId < parent))
      ) {
        parent = groundId;
        parentLevel = groundLevel;
      }
    }
    parentOf.set(id, parent);
  }

  const children = new Map<string | null, string[]>();
  for (const id of ids) {
    const parent = parentOf.get(id) ?? null;
    const list = children.get(parent) ?? [];
    list.push(id);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort();

  // Preferred direction per decision, inherited down the genealogy.
  const preferred = new Map<string, OrbitPoint>();
  const roots = children.get(null) ?? [];
  const rootDirections = fibonacciDirections(roots.length, 0);
  roots.forEach((id, position) => {
    const point = rootDirections[position];
    if (point !== undefined) preferred.set(id, point);
  });

  const rootSet = new Set(roots);
  const decisionOrder = ids
    .filter((id) => !rootSet.has(id))
    .sort(
      (left, right) =>
        (decisionLevel.get(left) ?? 1) - (decisionLevel.get(right) ?? 1) ||
        left.localeCompare(right),
    );
  for (const id of decisionOrder) {
    const parent = parentOf.get(id);
    if (parent === null || parent === undefined) {
      preferred.set(id, normalize({ x: hashAngle(id), y: 1, z: hashAngle(`${id}:z`) }));
      continue;
    }
    const parentDirection = preferred.get(parent);
    if (parentDirection === undefined) {
      preferred.set(id, normalize({ x: hashAngle(id), y: 1, z: hashAngle(`${id}:z`) }));
      continue;
    }
    const siblings = children.get(parent) ?? [];
    preferred.set(
      id,
      childDirection(parentDirection, siblings.indexOf(id), siblings.length, parent),
    );
  }

  const byLevel = new Map<number, string[]>();
  for (const id of ids) {
    const level = decisionLevel.get(id) ?? 1;
    const list = byLevel.get(level) ?? [];
    list.push(id);
    byLevel.set(level, list);
  }
  for (const list of byLevel.values()) list.sort();

  // Shell radius per depth: grows with the node count so crowded levels get
  // room, and never shrinks below the previous shell plus a minimum gap.
  const shells = new Map<number, number>();
  let previous = MIN_SHELL - MIN_SHELL_GAP;
  const levels = [...byLevel.keys()].sort((left, right) => left - right);
  for (const level of levels) {
    const count = byLevel.get(level)?.length ?? 0;
    const crowded = count === 0 ? 0 : Math.sqrt((count * SHELL_AREA_PER_NODE) / (4 * Math.PI));
    const grown = MIN_SHELL + LEVEL_STEP * Math.max(0, level - 1);
    const radius = Math.max(MIN_SHELL, grown, crowded, previous + MIN_SHELL_GAP);
    shells.set(level, radius);
    previous = radius;
  }

  // A decision sits exactly where its lineage points: stars on one lineage
  // therefore form a radial filament from the core outwards.
  const positions = new Map<string, OrbitPoint>();
  for (const id of ids) {
    const direction =
      preferred.get(id) ?? normalize({ x: hashAngle(id), y: 1, z: hashAngle(`${id}:z`) });
    const shell = shells.get(decisionLevel.get(id) ?? 1) ?? MIN_SHELL;
    positions.set(id, scale(direction, shell));
  }

  let radius = ORBIT_ROOT_STAR_RADIUS;
  for (const id of ids) {
    const position = positions.get(id)!;
    radius = Math.max(radius, Math.hypot(position.x, position.y, position.z) + ORBIT_STAR_RADIUS);
  }
  return {
    positions,
    radius: radius + FIT_CLEARANCE,
    levels: decisionLevel,
    parents: parentOf,
  };
}
