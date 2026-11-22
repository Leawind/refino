/**
 * Three-dimensional force layout for the orbit view (ui DESIGN.md, "三维视图").
 *
 * The deterministic shell layout seeds the session: every body starts where
 * the radial layout put it, so the first frame is readable and the same
 * working set always starts from the same shape. From there the simulation
 * takes over and decides where the stars actually rest.
 *
 * Every grounds edge is a spring, so all relationships act on the layout, not
 * just the genealogy edges. Repulsion spaces neighbouring stars (and therefore
 * their satellite rings), the virtual root anchors the root decisions at the
 * core, and a one-sided radial constraint keeps a decision beyond its grounds
 * so "farther from the core" keeps meaning "downstream" without pinning anyone
 * to a shell. Depth therefore emerges from the graph: the resting radius is
 * the balance of the anchored spring chain, the local crowding and any merge
 * edge reaching a shallower ground, and same-generation decisions sit at
 * similar but not identical radii.
 *
 * An episode ends by a sustained quiet run rather than a tick count, so the
 * simulation only runs while the shape is actually moving. Dragging a star
 * pins it and wakes the episode; releasing it lets the shape relax again.
 */

export interface OrbitForcePoint {
  x: number;
  y: number;
  z: number;
}

export interface OrbitForceNodeInput extends OrbitForcePoint {
  id: string;
  /** Lineage depth: 1 for a root decision. */
  depth: number;
  /** A decision grounded only by premises or nodes outside the working set. */
  root: boolean;
}

export interface OrbitForceEdgeInput {
  from: string;
  to: string;
}

/** Rest length of one lineage step, in world units: about the shell gap of
 * the seed layout, wide enough for the satellite rings of both hosts. */
const EDGE_REST = 3.4;
/** Rest length of the virtual root's springs to the root decisions. */
const ROOT_REST = 4.8;
/** Spring stiffness: force per unit of stretch. */
const SPRING = 0.35;
/** Anchor springs are stiffer than lineage springs so the core holds the
 * graph against the outward push. */
const ANCHOR_SPRING = 0.6;
/** Pair repulsion constant: force = k / d² above the floor, tapered to zero
 * at the repulsion reach. */
const REPULSION = 12;
/** Softening radius: below it the repulsion stops growing, keeping near
 * contacts orderly instead of divergent. */
const REPULSION_FLOOR = 1.1;
/** Repulsion reach: spacing is a neighbourhood effect, and an all-pairs force
 * would make a large working set both slow and unable to settle, because the
 * far side of the ball keeps pushing the near side. */
const REPULSION_RANGE = 9;
/** Radial ordering stiffness: acts only while a decision sits closer to the
 * core than its own ground. */
const ORDER = 0.35;
/** Smallest radial gain of one lineage step. */
const RADIAL_STEP = 1.6;
/** Fraction of velocity kept every tick. */
const DAMPING = 0.5;
/** Per-tick speed clamp: a drag or a new node injects a large impulse and must
 * not teleport the shape. */
const MAX_SPEED = 4;
/** Per-tick speed under which a body counts as quiet. */
const STOP_SPEED = 0.02;
/** Consecutive quiet ticks required to call the shape stable. */
const STABLE_TICKS = 15;
/** Past this many ticks of one episode, damping ramps up so constrained
 * shapes can actually reach the quiet run. */
const SETTLE_BEGIN_TICKS = 300;
const SETTLE_RAMP_TICKS = 500;
const SETTLE_DAMPING = 0.95;
/** Anti-hang guard; normal episodes end through the stability criterion. */
const MAX_TICKS = 8000;

interface Body extends OrbitForcePoint {
  id: string;
  depth: number;
  root: boolean;
  vx: number;
  vy: number;
  vz: number;
  pinned: boolean;
}

interface Spring {
  /** Shallower end. */
  from: Body;
  /** Deeper end. */
  to: Body;
  /** Rest length, already scaled by the lineage span. */
  rest: number;
  stiffness: number;
}

/** One relaxing episode over a fixed node set. */
export class OrbitForceSession {
  readonly #bodies: Body[];
  readonly #byId = new Map<string, Body>();
  readonly #rank = new Map<Body, number>();
  readonly #springs: Spring[] = [];
  readonly #anchored: Body[] = [];
  readonly #positions = new Map<string, OrbitForcePoint>();
  /** Per-tick accelerations, indexed like #bodies. */
  readonly #ax: Float64Array;
  readonly #ay: Float64Array;
  readonly #az: Float64Array;
  #ticks = 0;
  #quiet = 0;
  #settled = false;

  constructor(
    nodes: readonly OrbitForceNodeInput[],
    edges: readonly OrbitForceEdgeInput[],
    seed?: ReadonlyMap<string, OrbitForcePoint>,
  ) {
    const ordered = [...nodes].sort((left, right) => left.id.localeCompare(right.id));
    this.#ax = new Float64Array(ordered.length);
    this.#ay = new Float64Array(ordered.length);
    this.#az = new Float64Array(ordered.length);
    this.#bodies = ordered.map((node, index) => {
      const start = seed?.get(node.id) ?? node;
      const body: Body = {
        id: node.id,
        depth: node.depth,
        root: node.root,
        x: start.x,
        y: start.y,
        z: start.z,
        vx: 0,
        vy: 0,
        vz: 0,
        pinned: false,
      };
      this.#byId.set(body.id, body);
      this.#rank.set(body, index);
      this.#positions.set(body.id, body);
      if (body.root) this.#anchored.push(body);
      return body;
    });
    // A spring entering a crowded generation shares the load instead of
    // over-constraining its members.
    const enteredByDepth = new Map<number, number>();
    for (const body of this.#bodies) {
      if (body.root) continue;
      enteredByDepth.set(body.depth, (enteredByDepth.get(body.depth) ?? 0) + 1);
    }
    for (const edge of edges) {
      const first = this.#byId.get(edge.from);
      const second = this.#byId.get(edge.to);
      if (first === undefined || second === undefined || first === second) continue;
      const from = first.depth <= second.depth ? first : second;
      const to = from === first ? second : first;
      const span = Math.max(1, to.depth - from.depth);
      const share = enteredByDepth.get(to.depth) ?? 1;
      this.#springs.push({
        from,
        to,
        rest: EDGE_REST * span,
        stiffness: SPRING / Math.sqrt(share),
      });
    }
  }

  /** Live positions, keyed by node id. */
  get positions(): ReadonlyMap<string, OrbitForcePoint> {
    return this.#positions;
  }

  get settled(): boolean {
    return this.#settled;
  }

  get ticks(): number {
    return this.#ticks;
  }

  /** Hold a body at `point` (dragging), or release it with null. */
  pin(id: string, point: OrbitForcePoint | null): void {
    const body = this.#byId.get(id);
    if (body === undefined) return;
    if (point === null) {
      body.pinned = false;
    } else {
      body.x = point.x;
      body.y = point.y;
      body.z = point.z;
      body.vx = 0;
      body.vy = 0;
      body.vz = 0;
      body.pinned = true;
    }
    // The balance changed, so the episode must run again even if it had
    // already come to rest.
    this.#settled = false;
    this.#quiet = 0;
  }

  /** Advance one tick; returns whether the session is still moving. */
  step(): boolean {
    if (this.#settled) return false;
    this.#ticks += 1;
    this.#ax.fill(0);
    this.#ay.fill(0);
    this.#az.fill(0);
    this.#applySprings();
    this.#applyAnchors();
    this.#applyRepulsion();
    this.#applyOrdering();
    const ramp = Math.min(1, Math.max(0, (this.#ticks - SETTLE_BEGIN_TICKS) / SETTLE_RAMP_TICKS));
    const damping = DAMPING + (SETTLE_DAMPING - DAMPING) * ramp;
    let fastest = 0;
    this.#bodies.forEach((body, index) => {
      if (body.pinned) {
        body.vx = 0;
        body.vy = 0;
        body.vz = 0;
        return;
      }
      let vx = (body.vx + this.#ax[index]!) * damping;
      let vy = (body.vy + this.#ay[index]!) * damping;
      let vz = (body.vz + this.#az[index]!) * damping;
      const speed = Math.hypot(vx, vy, vz);
      if (speed > MAX_SPEED) {
        const scale = MAX_SPEED / speed;
        vx *= scale;
        vy *= scale;
        vz *= scale;
      }
      body.vx = vx;
      body.vy = vy;
      body.vz = vz;
      body.x += vx;
      body.y += vy;
      body.z += vz;
      fastest = Math.max(fastest, speed);
    });
    this.#quiet = fastest < STOP_SPEED ? this.#quiet + 1 : 0;
    if (this.#quiet >= STABLE_TICKS || this.#ticks >= MAX_TICKS) {
      this.#settled = true;
      for (const body of this.#bodies) {
        body.vx = 0;
        body.vy = 0;
        body.vz = 0;
      }
      return false;
    }
    return true;
  }

  /** Run for up to `limit` ticks, stopping early once the shape is stable. */
  settle(limit = 1000): void {
    for (let tick = 0; tick < limit; tick += 1) {
      if (!this.step()) return;
    }
  }

  /** Distance of the farthest body from the origin. */
  extent(): number {
    let radius = 0;
    for (const body of this.#bodies) {
      radius = Math.max(radius, Math.hypot(body.x, body.y, body.z));
    }
    return radius;
  }

  #applySprings(): void {
    for (const spring of this.#springs) {
      const dx = spring.to.x - spring.from.x;
      const dy = spring.to.y - spring.from.y;
      const dz = spring.to.z - spring.from.z;
      const length = Math.hypot(dx, dy, dz) || 1e-6;
      const magnitude = spring.stiffness * (length - spring.rest);
      const fx = (dx / length) * magnitude;
      const fy = (dy / length) * magnitude;
      const fz = (dz / length) * magnitude;
      // The force on each end points at the other end.
      this.#push(spring.from, fx, fy, fz);
      this.#push(spring.to, -fx, -fy, -fz);
    }
  }

  #applyAnchors(): void {
    for (const body of this.#anchored) {
      const length = Math.hypot(body.x, body.y, body.z) || 1e-6;
      const magnitude = ANCHOR_SPRING * (length - ROOT_REST);
      this.#push(
        body,
        (-body.x / length) * magnitude,
        (-body.y / length) * magnitude,
        (-body.z / length) * magnitude,
      );
    }
  }

  /** Repulsion from the 27 neighbouring cells of a uniform grid at the
   * repulsion reach; every pair is applied once, from the lower rank. */
  #applyRepulsion(): void {
    const grid = new Map<number, Body[]>();
    const cellX = new Int32Array(this.#bodies.length);
    const cellY = new Int32Array(this.#bodies.length);
    const cellZ = new Int32Array(this.#bodies.length);
    const coordinate = (value: number): number => Math.floor(value / REPULSION_RANGE) + 1024;
    const keyOf = (x: number, y: number, z: number): number => (x * 2048 + y) * 2048 + z;
    this.#bodies.forEach((body, index) => {
      cellX[index] = coordinate(body.x);
      cellY[index] = coordinate(body.y);
      cellZ[index] = coordinate(body.z);
      const key = keyOf(cellX[index]!, cellY[index]!, cellZ[index]!);
      const cell = grid.get(key);
      if (cell === undefined) grid.set(key, [body]);
      else cell.push(body);
    });
    const range2 = REPULSION_RANGE * REPULSION_RANGE;
    for (let index = 0; index < this.#bodies.length; index += 1) {
      const a = this.#bodies[index]!;
      const ix = cellX[index]!;
      const iy = cellY[index]!;
      const iz = cellZ[index]!;
      for (let ox = -1; ox <= 1; ox += 1) {
        for (let oy = -1; oy <= 1; oy += 1) {
          for (let oz = -1; oz <= 1; oz += 1) {
            const cell = grid.get(keyOf(ix + ox, iy + oy, iz + oz));
            if (cell === undefined) continue;
            for (const b of cell) {
              if (this.#rank.get(b)! <= index) continue;
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const dz = b.z - a.z;
              const distance = Math.hypot(dx, dy, dz);
              if (distance >= REPULSION_RANGE) continue;
              const soft = Math.max(distance, REPULSION_FLOOR);
              const magnitude = REPULSION * (1 / (soft * soft) - 1 / range2);
              if (distance < 1e-6) {
                // Coincident bodies have no direction; nudge them apart on a
                // deterministic axis.
                this.#push(a, 0, -magnitude, 0);
                this.#push(b, 0, magnitude, 0);
                continue;
              }
              const fx = (dx / distance) * magnitude;
              const fy = (dy / distance) * magnitude;
              const fz = (dz / distance) * magnitude;
              this.#push(a, -fx, -fy, -fz);
              this.#push(b, fx, fy, fz);
            }
          }
        }
      }
    }
  }

  /** One-sided: a decision never settles closer to the core than its ground,
   * but nothing fixes its radius. */
  #applyOrdering(): void {
    for (const spring of this.#springs) {
      const parent = spring.from;
      const child = spring.to;
      const parentRadius = Math.hypot(parent.x, parent.y, parent.z);
      const childRadius = Math.hypot(child.x, child.y, child.z);
      const deficit = parentRadius + RADIAL_STEP - childRadius;
      if (deficit <= 0) continue;
      const magnitude = ORDER * deficit;
      const parentLength = parentRadius || 1e-6;
      const childLength = childRadius || 1e-6;
      this.#push(
        child,
        (child.x / childLength) * magnitude,
        (child.y / childLength) * magnitude,
        (child.z / childLength) * magnitude,
      );
      this.#push(
        parent,
        (-parent.x / parentLength) * magnitude,
        (-parent.y / parentLength) * magnitude,
        (-parent.z / parentLength) * magnitude,
      );
    }
  }

  #push(body: Body, x: number, y: number, z: number): void {
    const index = this.#rank.get(body)!;
    this.#ax[index]! += x;
    this.#ay[index]! += y;
    this.#az[index]! += z;
  }
}
