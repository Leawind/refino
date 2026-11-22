/**
 * three.js scene for the orbit view (ui DESIGN.md, "三维视图"): the decisions
 * of the working set as a constellation around the virtual root star.
 * Lineage depth is distance from the core and branches run radially
 * outwards, so upstream and downstream are read from position. Every premise
 * is a satellite copy orbiting a decision that grounds on it (or the root
 * when no displayed decision does); a focused system keeps revolving and
 * shows a barely visible orbit track. Grounds edges only connect decisions;
 * extra grounds join the picture around an interacted node, so the resting
 * view stays a tree.
 *
 * The satellite revolution is the one persistent animation, so the frame
 * loop keeps running while a scene is mounted.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Fog,
  LineBasicMaterial,
  LineSegments,
  MOUSE,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TOUCH,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { RGBA } from "../render/renderer";
import {
  clampLimitingFov,
  easeBlend,
  fitDistance,
  fovForLimiting,
  glideCenter,
  limitingFov,
  logGlowScale,
  MAX_FOV,
  MIN_FOV,
  pointDistance,
  scaleAtDistance,
  wheelFov,
  wheelTargetDistance,
  zoomDistance,
} from "./camera";
import { ORBIT_ROOT_STAR_RADIUS, ORBIT_STAR_RADIUS } from "./layout";
import { ORBIT_THEME } from "./theme";
import type { OrbitTheme } from "./theme";

export interface OrbitSceneNode {
  id: string;
  x: number;
  y: number;
  z: number;
  /** Lineage depth: 1 for root decisions. */
  depth: number;
  /** A root decision: the virtual root's direct child. */
  root: boolean;
}

export interface OrbitSceneEdge {
  from: string;
  to: string;
  /** The genealogy edge (the deepest ground of its decision). */
  primary: boolean;
}

/** A premise copy orbiting one host decision (or the virtual root when the
 * premise is unreferenced). Shared premises get one copy per consumer. */
export interface OrbitSceneSatellite {
  /** Unique per copy: a premise may orbit several hosts. */
  key: string;
  /** Data node id of the premise. */
  id: string;
  /** Host decision id, or null for the virtual root. */
  host: string | null;
  radius: number;
  /** Initial angle on the ring. */
  phase: number;
  /** Orthonormal basis of the ring plane. */
  axisA: { x: number; y: number; z: number };
  axisB: { x: number; y: number; z: number };
}

/** Special scene key for the display-only virtual root. */
export const ORBIT_ROOT_ID = "__root__";

export interface OrbitPick {
  /** Unique scene key: a decision id, a satellite key or ORBIT_ROOT_ID. */
  key: string;
  /** Data node id, or null for the virtual root. */
  id: string | null;
}

/** A screen-space projection of a scene point, for DOM labels. */
export interface OrbitProjection {
  x: number;
  y: number;
  visible: boolean;
}

/** One rendered star: a decision, or one satellite copy of a premise. */
interface SceneItem {
  key: string;
  id: string;
  satellite: OrbitSceneSatellite | null;
}

/** One animated halo around an interacted star. */
interface HaloState {
  sprite: Sprite;
  kind: "selection" | "hover";
  /** Current radius multiplier; eases towards `target` every frame. */
  scale: number;
  /** Resting multiplier, or 0 while the halo fades out. */
  target: number;
}

const CAMERA_FOV = 45;
const MIN_DISTANCE = 2.5;
const PICK_RADIUS = 16;
/** The virtual root's glow is smaller than a star, so its click target is
 * generous; it is only picked when no star is under the pointer. */
const ROOT_PICK_RADIUS = 14;
const STAR_SIZE = 2.4;
const STAR_GLOW_SIZE = 5.5;
const POSITION_TAU_MS = 90;
/** The orbit center glides to a clicked star instead of jumping. */
const CENTER_TAU_MS = 160;
/** Interacted stars grow their halo instead of popping it in. */
const HALO_TAU_MS = 110;
/** Wheel/zoom commands ease the distance in. */
const ZOOM_TAU_MS = 70;
/** One satellite revolution takes this long; all rings share the speed so
 * their formation never drifts apart. */
const SATELLITE_PERIOD_MS = 26000;
const SATELLITE_SPEED = (Math.PI * 2) / SATELLITE_PERIOD_MS;
/** The focused system's ring is only a hint, never a highlight. */
const TRACK_OPACITY = 0.12;
/** Halo radius multipliers; the selection glow is the larger one. Satellite
 * copies use a much smaller halo than decisions, in keeping with their size. */
const HALO_SCALE = {
  decision: { selection: 5.5, hover: 4.5 },
  satellite: { selection: 2.4, hover: 2.0 },
} as const;
const HALO_MIN_SCALE = 0.01;
/** The virtual root stays a modest mark: hover and focus only enlarge its
 * glow slightly, and its opacity starts well below a node halo. */
const ROOT_GLOW_BASE = 1.3;
const ROOT_GLOW_HOVER = 1.45;
const ROOT_GLOW_FOCUS = 1.6;
const ROOT_OPACITY_BASE = 0.6;
const ROOT_OPACITY_HOVER = 0.75;
const ROOT_OPACITY_FOCUS = 0.9;

function colorOf(value: RGBA): Color {
  return new Color().setRGB(value[0], value[1], value[2], SRGBColorSpace);
}

function textureCanvas(size: number): {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
} {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("2D canvas unavailable");
  return { canvas, context };
}

/** A star: a tight core, a small halo and four symmetric flares. Every ray
 * starts at the core and fades to its tip, so the bright, thick end is the
 * center of the star, never one side of a line. */
function starTexture(): CanvasTexture {
  const size = 128;
  const center = size / 2;
  const { canvas, context } = textureCanvas(size);
  const halo = context.createRadialGradient(center, center, 0, center, center, center);
  halo.addColorStop(0, "rgba(255, 255, 255, 1)");
  halo.addColorStop(0.05, "rgba(255, 255, 255, 0.95)");
  halo.addColorStop(0.12, "rgba(220, 236, 255, 0.4)");
  halo.addColorStop(0.24, "rgba(180, 210, 255, 0.08)");
  halo.addColorStop(0.45, "rgba(150, 190, 255, 0)");
  context.fillStyle = halo;
  context.fillRect(0, 0, size, size);
  context.globalCompositeOperation = "lighter";
  context.lineCap = "round";
  const drawRay = (angle: number, length: number, width: number, alpha: number): void => {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const flare = context.createLinearGradient(
      center,
      center,
      center + dx * length,
      center + dy * length,
    );
    flare.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
    flare.addColorStop(0.12, `rgba(255, 255, 255, ${alpha * 0.5})`);
    flare.addColorStop(0.45, `rgba(214, 233, 255, ${alpha * 0.12})`);
    flare.addColorStop(1, "rgba(180, 210, 255, 0)");
    context.strokeStyle = flare;
    context.lineWidth = width;
    context.beginPath();
    context.moveTo(center, center);
    context.lineTo(center + dx * length, center + dy * length);
    context.stroke();
  };
  for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    drawRay(angle, center * 0.92, 1, 0.85);
    drawRay(angle, center * 0.5, 3.2, 0.16);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Soft radial glow, used for halos around selected stars. */
function haloTexture(): CanvasTexture {
  const size = 128;
  const center = size / 2;
  const { canvas, context } = textureCanvas(size);
  const halo = context.createRadialGradient(center, center, 0, center, center, center);
  halo.addColorStop(0, "rgba(255, 255, 255, 0.8)");
  halo.addColorStop(0.22, "rgba(255, 255, 255, 0.18)");
  halo.addColorStop(0.55, "rgba(255, 255, 255, 0.03)");
  halo.addColorStop(1, "rgba(255, 255, 255, 0)");
  context.fillStyle = halo;
  context.fillRect(0, 0, size, size);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** A fixed, very faint star field behind the constellation. It gives the
 * empty canvas a sky without competing with the actual nodes. */
function buildSky(material: PointsMaterial): Points {
  let seed = 0x9e3779b9;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const count = 1900;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let index = 0; index < count; index++) {
    const z = random() * 2 - 1;
    const radius = Math.sqrt(Math.max(0, 1 - z * z));
    const angle = random() * Math.PI * 2;
    const distance = 900 + random() * 600;
    positions[index * 3] = Math.cos(angle) * radius * distance;
    positions[index * 3 + 1] = z * distance;
    positions[index * 3 + 2] = Math.sin(angle) * radius * distance;
    const brightness = 0.22 + random() * 0.6;
    colors[index * 3] = brightness * 0.72;
    colors[index * 3 + 1] = brightness * 0.84;
    colors[index * 3 + 2] = brightness;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  const sky = new Points(geometry, material);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  return sky;
}

export class OrbitScene {
  readonly #canvas: HTMLCanvasElement;
  readonly #renderer: WebGLRenderer;
  readonly #scene = new Scene();
  readonly #camera: PerspectiveCamera;
  readonly #controls: OrbitControls;
  readonly #starCanvas = starTexture();
  readonly #haloCanvas = haloTexture();
  readonly #starMaterial = new PointsMaterial({
    map: this.#starCanvas,
    size: STAR_SIZE,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    vertexColors: true,
    sizeAttenuation: true,
  });
  readonly #glowMaterial = new PointsMaterial({
    map: this.#haloCanvas,
    size: STAR_GLOW_SIZE,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
    blending: AdditiveBlending,
    vertexColors: true,
    sizeAttenuation: true,
  });
  /** Premise satellites are small and faint by design; they use the soft
   * halo texture (no star flares) and never receive a glow layer. A small
   * sprite keeps the halo tight, so the core can stay bright. */
  readonly #satelliteMaterial = new PointsMaterial({
    map: this.#haloCanvas,
    size: 1.2,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    blending: AdditiveBlending,
    vertexColors: true,
    sizeAttenuation: true,
  });
  readonly #edgeMaterial = new LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.65,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  /** The focused system's orbital ring, a whisper of a circle. */
  readonly #trackMaterial = new LineBasicMaterial({
    color: colorOf(ORBIT_THEME.edge),
    transparent: true,
    opacity: TRACK_OPACITY,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  /** Virtual-root rays are much fainter than lineage edges: they only hint
   * at where the tree starts. */
  readonly #rootRayMaterial = new LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  readonly #rootMaterial = new SpriteMaterial({
    map: this.#haloCanvas,
    color: colorOf(ORBIT_THEME.root),
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  readonly #selectionMaterial = new SpriteMaterial({
    map: this.#haloCanvas,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: AdditiveBlending,
    opacity: 0.7,
  });
  readonly #hoverMaterial = new SpriteMaterial({
    map: this.#haloCanvas,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: AdditiveBlending,
    opacity: 0.45,
  });
  readonly #root: Sprite;
  readonly #theme: OrbitTheme = ORBIT_THEME;

  #decisions: OrbitSceneNode[] = [];
  #satellites: OrbitSceneSatellite[] = [];
  #items: SceneItem[] = [];
  #itemByKey = new Map<string, SceneItem>();
  #current = new Map<string, Vector3>();
  #targets = new Map<string, Vector3>();
  #depths = new Map<string, number>();
  /** Current world position per satellite key. */
  #satellitePositions = new Map<string, Vector3>();
  /** Current ring angle per satellite key; preserved across rebuilds. */
  #satelliteAngles = new Map<string, number>();
  #edges: OrbitSceneEdge[] = [];
  #visibleEdges: OrbitSceneEdge[] = [];
  #points: Points | null = null;
  #glow: Points | null = null;
  #satellitePoints: Points | null = null;
  #pointsPositions = new Float32Array(0);
  #glowPositions = new Float32Array(0);
  #satelliteBuffer = new Float32Array(0);
  #edgeLines: LineSegments | null = null;
  #edgePositions = new Float32Array(0);
  #rootRays: LineSegments | null = null;
  #rootRayPositions = new Float32Array(0);
  #rootIds: string[] = [];
  #selection = new Set<string>();
  #hovered: string | null = null;
  #halos = new Map<string, HaloState>();
  /** Scene key the orbit center is gliding to; null when idle. */
  #focusKey: string | null = null;
  #rootHovered = false;
  #rootScale = ROOT_GLOW_BASE;
  #rootOpacity = ROOT_OPACITY_BASE;
  /** Faint ring of the focused system's satellites. */
  #track: LineSegments | null = null;
  #trackHost: string | null = null;
  readonly #sky: Points;
  readonly #skyMaterial = new PointsMaterial({
    map: this.#haloCanvas,
    size: 1.6,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
    blending: AdditiveBlending,
    vertexColors: true,
    fog: false,
  });
  #boundsRadius = ORBIT_ROOT_STAR_RADIUS;
  #fitReference = 20;
  #width = 1;
  #height = 1;
  #frame = 0;
  #lastTime = 0;
  /** Distance the smooth wheel zoom is heading for; null when idle. */
  #zoomTarget: number | null = null;
  /** Narrower viewing angle the wheel or the FOV slider is heading for. */
  #fovTarget: number | null = null;
  /** FOV the current fit distance was computed for. */
  #fitFov = CAMERA_FOV;
  readonly #wheelHandler: (event: WheelEvent) => void;
  /** Ctrl state tracked from key events: some hosts deliver Ctrl+wheel with
   * `ctrlKey` cleared, so the wheel alone is not reliable. */
  #ctrlHeld = false;
  readonly #onKeyDown: (event: KeyboardEvent) => void;
  readonly #onKeyUp: (event: KeyboardEvent) => void;
  readonly #onWindowBlur: () => void;
  #cameraListener: (() => void) | null = null;
  #frameListener: (() => void) | null = null;
  #projected = new Vector3();
  #origin = new Vector3();
  #disposed = false;

  private constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    this.#renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.#renderer.setClearAlpha(0);
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.#camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.1, 20000);
    this.#camera.position.set(0.55, 0.42, 1).normalize().multiplyScalar(20);
    this.#controls = new OrbitControls(this.#camera, canvas);
    this.#controls.enableDamping = true;
    this.#controls.dampingFactor = 0.08;
    this.#controls.enablePan = false;
    this.#controls.rotateSpeed = 0.8;
    this.#controls.zoomSpeed = 0.9;
    this.#controls.minDistance = MIN_DISTANCE;
    this.#controls.maxDistance = 4000;
    // Middle-drag dolly duplicates the wheel; leave it inert.
    this.#controls.mouseButtons = { LEFT: null, MIDDLE: null, RIGHT: MOUSE.ROTATE };
    // Wheel zoom is ours: it eases towards a target distance with a coarse
    // step per notch. OrbitControls would snap on every event.
    this.#controls.enableZoom = false;
    this.#wheelHandler = (event) => this.#onWheel(event);
    canvas.addEventListener("wheel", this.#wheelHandler, { passive: false });
    this.#onKeyDown = (event) => {
      if (event.key === "Control") this.#ctrlHeld = true;
    };
    this.#onKeyUp = (event) => {
      if (event.key === "Control") this.#ctrlHeld = false;
    };
    this.#onWindowBlur = () => {
      this.#ctrlHeld = false;
    };
    // Window-level so Ctrl works even when the wheel starts over the canvas
    // after focusing some other element.
    window.addEventListener("keydown", this.#onKeyDown);
    window.addEventListener("keyup", this.#onKeyUp);
    window.addEventListener("blur", this.#onWindowBlur);
    this.#controls.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_ROTATE };
    this.#controls.addEventListener("change", () => {
      this.#notifyCamera();
      // Wheel and damping updates arrive outside the render loop; a change
      // must schedule the frame that shows it.
      this.#queue();
    });
    this.#controls.addEventListener("start", () => this.#queue());

    this.#sky = buildSky(this.#skyMaterial);
    this.#scene.add(this.#sky);
    this.#root = new Sprite(this.#rootMaterial);
    this.#root.scale.setScalar(ORBIT_ROOT_STAR_RADIUS * ROOT_GLOW_BASE);
    this.#rootMaterial.opacity = ROOT_OPACITY_BASE;
    this.#scene.add(this.#root);
    this.#selectionMaterial.color.copy(colorOf(this.#theme.highlight));
    this.#hoverMaterial.color.copy(colorOf(this.#theme.highlight));
    this.#scene.fog = new Fog(colorOf(this.#theme.background), 1, 1000);
    this.#scene.background = null;
  }

  static create(canvas: HTMLCanvasElement): OrbitScene | null {
    try {
      return new OrbitScene(canvas);
    } catch (error) {
      // WebGL2 unavailable: the component falls back to its message. The
      // reason is not actionable in the UI, but it belongs in the console.
      console.warn("orbit view: WebGL context unavailable", error);
      return null;
    }
  }

  /** Replace the displayed decision/satellite set. `fit` re-frames the camera
   * on the new bounds; expanding the working set keeps the user's viewpoint. */
  setData(
    nodes: readonly OrbitSceneNode[],
    satellites: readonly OrbitSceneSatellite[],
    edges: readonly OrbitSceneEdge[],
    fit: boolean,
  ): void {
    const ordered = [...nodes].sort((left, right) => left.id.localeCompare(right.id));
    const previous = this.#current;
    this.#decisions = ordered;
    this.#targets = new Map(
      ordered.map((node) => [node.id, new Vector3(node.x, node.y, node.z)] as const),
    );
    const next = new Map<string, Vector3>();
    for (const node of ordered) {
      const target = this.#targets.get(node.id)!;
      next.set(node.id, previous.get(node.id)?.clone() ?? target.clone());
    }
    this.#current = next;
    this.#depths = new Map(ordered.map((node) => [node.id, node.depth] as const));
    this.#satellites = [...satellites].sort((left, right) => left.key.localeCompare(right.key));
    this.#satelliteAngles = new Map(
      this.#satellites.map((satellite) => [
        satellite.key,
        this.#satelliteAngles.get(satellite.key) ?? satellite.phase,
      ]),
    );
    this.#satellitePositions = new Map(
      this.#satellites.map((satellite) => [
        satellite.key,
        this.#satellitePositions.get(satellite.key)?.clone() ?? new Vector3(),
      ]),
    );
    this.#items = [
      ...ordered.map((node) => ({ key: node.id, id: node.id, satellite: null })),
      ...this.#satellites.map((satellite) => ({
        key: satellite.key,
        id: satellite.id,
        satellite,
      })),
    ];
    this.#itemByKey = new Map(this.#items.map((item) => [item.key, item] as const));
    this.#edges = edges.map((edge) => ({ ...edge }));
    this.#updateSatellitePositions(0);
    this.#rebuildPoints();
    this.#rebuildEdges();
    this.#rebuildRootRays();
    this.#rebuildHalos();
    this.#rebuildTrack();
    this.#boundsRadius = ORBIT_ROOT_STAR_RADIUS;
    for (const node of ordered) {
      const position = this.#targets.get(node.id)!;
      this.#boundsRadius = Math.max(this.#boundsRadius, position.length() + ORBIT_STAR_RADIUS);
    }
    for (const satellite of this.#satellites) {
      const host =
        satellite.host === null ? new Vector3() : this.#targets.get(satellite.host)?.clone();
      if (host === undefined) continue;
      this.#boundsRadius = Math.max(
        this.#boundsRadius,
        host.length() + satellite.radius + ORBIT_STAR_RADIUS,
      );
    }
    if (fit) this.fitView();
    else this.#syncDistanceLimits();
    this.#queue();
  }

  setState(selection: ReadonlySet<string>, hovered: string | null): void {
    this.#selection = new Set(selection);
    this.#hovered = hovered;
    this.#applyPointColors();
    // Cross-links join the picture only around an interacted node; their
    // presence changes with hover/selection, so the edge mesh is rebuilt.
    this.#rebuildEdges();
    this.#rebuildHalos();
    this.#queue();
  }

  /** Pick the star under a canvas-local CSS-pixel point; the virtual root is
   * the fallback when no star is close. Null on empty space. */
  pick(x: number, y: number): OrbitPick | null {
    const width = Math.max(1, this.#width);
    const height = Math.max(1, this.#height);
    let best: OrbitPick | null = null;
    let bestDistance = PICK_RADIUS;
    let bestDepth = Number.POSITIVE_INFINITY;
    for (const item of this.#items) {
      const position =
        item.satellite === null
          ? this.#current.get(item.id)
          : this.#satellitePositions.get(item.key);
      if (position === undefined) continue;
      this.#projected.copy(position).project(this.#camera);
      if (this.#projected.z < -1 || this.#projected.z > 1) continue;
      const screenX = (this.#projected.x * 0.5 + 0.5) * width;
      const screenY = (-this.#projected.y * 0.5 + 0.5) * height;
      const distance = Math.hypot(screenX - x, screenY - y);
      if (distance > bestDistance) continue;
      const depth = this.#camera.position.distanceToSquared(position);
      if (distance < bestDistance - 0.5 || depth < bestDepth) {
        best = { key: item.key, id: item.id };
        bestDistance = Math.min(bestDistance, distance);
        bestDepth = depth;
      }
    }
    if (best !== null) return best;
    this.#projected.set(0, 0, 0).project(this.#camera);
    if (this.#projected.z < -1 || this.#projected.z > 1) return null;
    const rootX = (this.#projected.x * 0.5 + 0.5) * width;
    const rootY = (-this.#projected.y * 0.5 + 0.5) * height;
    if (Math.hypot(rootX - x, rootY - y) > ROOT_PICK_RADIUS) return null;
    return { key: ORBIT_ROOT_ID, id: null };
  }

  /** Project a scene point into canvas-local CSS pixels (DOM labels). */
  project(x: number, y: number, z: number): OrbitProjection {
    this.#projected.set(x, y, z).project(this.#camera);
    return {
      x: (this.#projected.x * 0.5 + 0.5) * this.#width,
      y: (-this.#projected.y * 0.5 + 0.5) * this.#height,
      visible: this.#projected.z > -1 && this.#projected.z < 1,
    };
  }

  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    this.#width = width;
    this.#height = height;
    this.#camera.aspect = width / height;
    // The limits are measured on the narrower axis, which can switch sides
    // with the aspect ratio; a surviving angle may now sit outside them.
    this.#camera.fov = fovForLimiting(
      clampLimitingFov(limitingFov(this.#camera.fov, this.#camera.aspect)),
      this.#camera.aspect,
    );
    this.#camera.updateProjectionMatrix();
    this.#renderer.setSize(width, height, false);
    this.#notifyCamera();
    this.#queue();
  }

  fitView(): void {
    this.#settleFov();
    const distance = fitDistance(this.#boundsRadius, this.#camera.fov, this.#camera.aspect, 0.96);
    const direction = this.#camera.position.clone().sub(this.#controls.target);
    if (direction.lengthSq() < 1e-9) direction.set(0.55, 0.42, 1);
    this.#controls.target.set(0, 0, 0);
    this.#camera.position.copy(direction.normalize().multiplyScalar(distance));
    this.#zoomTarget = null;
    this.#focusKey = null;
    this.#rebuildTrack();
    this.#fitReference = distance;
    this.#fitFov = this.#camera.fov;
    this.#syncDistanceLimits();
    this.#controls.update();
    this.#queue();
  }

  /** Frame the selected stars: the target moves to their centroid. A selected
   * premise contributes every visible satellite copy. */
  fitSelection(ids: readonly string[]): void {
    this.#settleFov();
    const points: Vector3[] = [];
    for (const id of ids) {
      const decision = this.#current.get(id);
      if (decision !== undefined) {
        points.push(decision);
        continue;
      }
      for (const item of this.#items) {
        if (item.satellite === null || item.id !== id) continue;
        const point = this.#itemPosition(item);
        if (point !== undefined) points.push(point);
      }
    }
    if (points.length === 0) {
      this.fitView();
      return;
    }
    const center = new Vector3();
    for (const point of points) center.add(point);
    center.divideScalar(points.length);
    let radius = ORBIT_STAR_RADIUS;
    for (const point of points) radius = Math.max(radius, pointDistance(point, center) + 1);
    const previous = this.#controls.target.clone();
    const direction = this.#camera.position.clone().sub(previous);
    if (direction.lengthSq() < 1e-9) direction.set(0.55, 0.42, 1);
    const distance = Math.min(
      this.#controls.maxDistance,
      Math.max(
        this.#controls.minDistance,
        fitDistance(radius, this.#camera.fov, this.#camera.aspect, 1.4),
      ),
    );
    this.#controls.target.copy(center);
    this.#camera.position.copy(center).add(direction.normalize().multiplyScalar(distance));
    this.#zoomTarget = null;
    this.#focusKey = null;
    this.#rebuildTrack();
    this.#controls.update();
    this.#notifyCamera();
    this.#queue();
  }

  /** Move the orbit center onto a scene key: a decision id, a satellite key
   * or ORBIT_ROOT_ID. The center glides there in #applySmoothCenter, and the
   * focused system keeps revolving. */
  focusOn(key: string): void {
    if (this.#focusKey === key) return;
    const known =
      key === ORBIT_ROOT_ID ||
      this.#current.has(key) ||
      this.#satellites.some((satellite) => satellite.key === key);
    if (!known) return;
    this.#focusKey = key;
    this.#rebuildTrack();
    this.#queue();
  }

  /** Hover state of the display-only virtual root. Its glow only grows a
   * little; the white color carries its role. */
  setRootHover(hovered: boolean): void {
    if (this.#rootHovered === hovered) return;
    this.#rootHovered = hovered;
    this.#queue();
  }

  zoomBy(factor: number): void {
    const base = this.#zoomTarget ?? this.#distance();
    this.#zoomTarget = zoomDistance(
      base,
      factor,
      this.#controls.minDistance,
      this.#controls.maxDistance,
    );
    this.#queue();
  }

  /** Narrower viewing angle and its limits, as the FOV control reads them. */
  get fov(): { value: number; min: number; max: number } {
    return {
      value: this.#fovTarget ?? limitingFov(this.#camera.fov, this.#camera.aspect),
      min: MIN_FOV,
      max: MAX_FOV,
    };
  }

  /** Ease the narrower viewing angle to `value`; the camera distance stays
   * where it is. */
  setFov(value: number): void {
    if (!Number.isFinite(value)) return;
    const target = clampLimitingFov(value);
    if (target === (this.#fovTarget ?? limitingFov(this.#camera.fov, this.#camera.aspect))) {
      return;
    }
    this.#fovTarget = target;
    this.#queue();
  }

  /** Zoom readout: 100% at the fitted distance. */
  get scale(): number {
    return scaleAtDistance(
      this.#fitReference,
      this.#camera.position.distanceTo(this.#controls.target),
    );
  }

  get viewport(): { width: number; height: number } {
    return { width: this.#width, height: this.#height };
  }

  onCameraChanged(handler: (() => void) | null): void {
    this.#cameraListener = handler;
  }

  onFrame(handler: (() => void) | null): void {
    this.#frameListener = handler;
  }

  requestRender(): void {
    this.#queue();
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#frame !== 0) cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.#halos.clear();
    this.#focusKey = null;
    this.#satellitePositions.clear();
    this.#satelliteAngles.clear();
    this.#track?.geometry.dispose();
    this.#track = null;
    this.#canvas.removeEventListener("wheel", this.#wheelHandler);
    window.removeEventListener("keydown", this.#onKeyDown);
    window.removeEventListener("keyup", this.#onKeyUp);
    window.removeEventListener("blur", this.#onWindowBlur);
    this.#controls.dispose();
    this.#starCanvas.dispose();
    this.#haloCanvas.dispose();
    this.#starMaterial.dispose();
    this.#glowMaterial.dispose();
    this.#satelliteMaterial.dispose();
    this.#edgeMaterial.dispose();
    this.#rootMaterial.dispose();
    this.#selectionMaterial.dispose();
    this.#hoverMaterial.dispose();
    this.#trackMaterial.dispose();
    this.#points?.geometry.dispose();
    this.#glow?.geometry.dispose();
    this.#satellitePoints?.geometry.dispose();
    this.#sky.geometry.dispose();
    this.#skyMaterial.dispose();
    this.#edgeLines?.geometry.dispose();
    this.#rootRays?.geometry.dispose();
    this.#rootRayMaterial.dispose();
    this.#renderer.dispose();
  }

  #distance(): number {
    return this.#camera.position.distanceTo(this.#controls.target);
  }

  /** A wheel notch covers roughly a quarter of the current distance; small
   * trackpad deltas scale continuously. With Ctrl held the same notch changes
   * the field of view instead, leaving the camera distance alone. Both ease
   * towards their target in the smooth apply methods instead of snapping. */
  #onWheel(event: WheelEvent): void {
    event.preventDefault();
    const delta =
      event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaMode === 2
          ? event.deltaY * 100
          : event.deltaY;
    if (event.ctrlKey || this.#ctrlHeld || event.getModifierState("Control")) {
      const current = this.#fovTarget ?? limitingFov(this.#camera.fov, this.#camera.aspect);
      this.#fovTarget = wheelFov(current, delta);
      this.#queue();
      return;
    }
    const base = this.#zoomTarget ?? this.#distance();
    const next = wheelTargetDistance(
      base,
      delta,
      this.#controls.minDistance,
      this.#controls.maxDistance,
    );
    if (!Number.isFinite(next)) return;
    this.#zoomTarget = next;
    this.#queue();
  }

  #applySmoothZoom(delta: number): boolean {
    if (this.#zoomTarget === null) return false;
    const target = this.#zoomTarget;
    const offset = this.#camera.position.clone().sub(this.#controls.target);
    const current = offset.length();
    const difference = target - current;
    if (Math.abs(difference) < 0.01) {
      this.#camera.position
        .copy(this.#controls.target)
        .add(offset.multiplyScalar(target / current));
      this.#zoomTarget = null;
      this.#notifyCamera();
      return false;
    }
    const blend = easeBlend(delta, ZOOM_TAU_MS);
    const next = current + difference * blend;
    this.#camera.position.copy(this.#controls.target).add(offset.multiplyScalar(next / current));
    this.#notifyCamera();
    return true;
  }

  #applySmoothFov(delta: number): boolean {
    if (this.#fovTarget === null) return false;
    const target = this.#fovTarget;
    const current = limitingFov(this.#camera.fov, this.#camera.aspect);
    const difference = target - current;
    if (Math.abs(difference) < 0.01) {
      this.#camera.fov = fovForLimiting(target, this.#camera.aspect);
      this.#camera.updateProjectionMatrix();
      this.#fovTarget = null;
      this.#notifyCamera();
      return false;
    }
    const next = current + difference * easeBlend(delta, ZOOM_TAU_MS);
    this.#camera.fov = fovForLimiting(next, this.#camera.aspect);
    this.#camera.updateProjectionMatrix();
    this.#notifyCamera();
    return true;
  }

  /** Finish a pending FOV adjustment before an explicit fit measures the
   * scene with the field of view that will actually be used. */
  #settleFov(): void {
    if (this.#fovTarget === null) return;
    this.#camera.fov = fovForLimiting(this.#fovTarget, this.#camera.aspect);
    this.#fovTarget = null;
    this.#camera.updateProjectionMatrix();
  }

  #syncDistanceLimits(): void {
    const fit = fitDistance(this.#boundsRadius, this.#camera.fov, this.#camera.aspect, 1.15);
    this.#controls.minDistance = MIN_DISTANCE;
    this.#controls.maxDistance = Math.max(fit * 10, 40);
  }

  #itemPosition(item: SceneItem): Vector3 | undefined {
    return item.satellite === null
      ? this.#current.get(item.id)
      : this.#satellitePositions.get(item.key);
  }

  #rebuildPoints(): void {
    for (const points of [this.#points, this.#glow, this.#satellitePoints]) {
      if (points === null) continue;
      this.#scene.remove(points);
      points.geometry.dispose();
    }
    this.#points = null;
    this.#glow = null;
    this.#satellitePoints = null;

    if (this.#decisions.length === 0) {
      this.#pointsPositions = new Float32Array(0);
      this.#glowPositions = new Float32Array(0);
    } else {
      this.#pointsPositions = new Float32Array(this.#decisions.length * 3);
      this.#glowPositions = new Float32Array(this.#decisions.length * 3);
      const colors = new Float32Array(this.#decisions.length * 3);
      const glowColors = new Float32Array(this.#decisions.length * 3);
      this.#decisions.forEach((node, index) => {
        const point = this.#current.get(node.id);
        if (point === undefined) return;
        this.#pointsPositions[index * 3] = point.x;
        this.#pointsPositions[index * 3 + 1] = point.y;
        this.#pointsPositions[index * 3 + 2] = point.z;
        this.#glowPositions[index * 3] = point.x;
        this.#glowPositions[index * 3 + 1] = point.y;
        this.#glowPositions[index * 3 + 2] = point.z;
      });
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(this.#pointsPositions, 3));
      geometry.setAttribute("color", new BufferAttribute(colors, 3));
      this.#points = new Points(geometry, this.#starMaterial);
      this.#points.frustumCulled = false;
      this.#scene.add(this.#points);
      const glowGeometry = new BufferGeometry();
      glowGeometry.setAttribute("position", new BufferAttribute(this.#glowPositions, 3));
      glowGeometry.setAttribute("color", new BufferAttribute(glowColors, 3));
      this.#glow = new Points(glowGeometry, this.#glowMaterial);
      this.#glow.frustumCulled = false;
      this.#scene.add(this.#glow);
    }

    if (this.#satellites.length === 0) {
      this.#satelliteBuffer = new Float32Array(0);
    } else {
      this.#satelliteBuffer = new Float32Array(this.#satellites.length * 3);
      const satelliteColors = new Float32Array(this.#satellites.length * 3);
      this.#satellites.forEach((satellite, index) => {
        const point = this.#satellitePositions.get(satellite.key);
        if (point === undefined) return;
        this.#satelliteBuffer[index * 3] = point.x;
        this.#satelliteBuffer[index * 3 + 1] = point.y;
        this.#satelliteBuffer[index * 3 + 2] = point.z;
      });
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(this.#satelliteBuffer, 3));
      geometry.setAttribute("color", new BufferAttribute(satelliteColors, 3));
      this.#satellitePoints = new Points(geometry, this.#satelliteMaterial);
      this.#satellitePoints.frustumCulled = false;
      this.#scene.add(this.#satellitePoints);
    }
    this.#applyPointColors();
  }

  #applyPointColors(): void {
    const shallow = colorOf(this.#theme.star);
    const deep = colorOf(this.#theme.deepStar);
    const premise = colorOf(this.#theme.premise);
    const highlight = colorOf(this.#theme.highlight);
    if (this.#points !== null && this.#glow !== null) {
      const attribute = this.#points.geometry.getAttribute("color");
      const glowAttribute = this.#glow.geometry.getAttribute("color");
      this.#decisions.forEach((node, index) => {
        const depth = Math.min(1, Math.max(0, ((this.#depths.get(node.id) ?? 1) - 1) / 9));
        const color = shallow.clone().lerp(deep, depth);
        if (this.#selection.has(node.id)) color.lerp(highlight, 0.8);
        else if (node.id === this.#hovered) color.lerp(highlight, 0.55);
        attribute.setXYZ(index, color.r, color.g, color.b);
        const glowColor = color.clone().multiplyScalar(0.55);
        glowAttribute.setXYZ(index, glowColor.r, glowColor.g, glowColor.b);
      });
      attribute.needsUpdate = true;
      glowAttribute.needsUpdate = true;
    }
    if (this.#satellitePoints !== null) {
      const attribute = this.#satellitePoints.geometry.getAttribute("color");
      this.#satellites.forEach((satellite, index) => {
        const color = premise.clone();
        if (this.#selection.has(satellite.id)) color.lerp(highlight, 0.8);
        else if (satellite.id === this.#hovered) color.lerp(highlight, 0.55);
        attribute.setXYZ(index, color.r, color.g, color.b);
      });
      attribute.needsUpdate = true;
    }
  }

  #rebuildRootRays(): void {
    if (this.#rootRays !== null) {
      this.#scene.remove(this.#rootRays);
      this.#rootRays.geometry.dispose();
      this.#rootRays = null;
    }
    this.#rootIds = this.#decisions.filter((node) => node.root).map((node) => node.id);
    if (this.#rootIds.length === 0) return;
    const positions = new Float32Array(this.#rootIds.length * 6);
    const colors = new Float32Array(this.#rootIds.length * 6);
    const start = colorOf(this.#theme.edge).multiplyScalar(0.12);
    const end = colorOf(this.#theme.edge).multiplyScalar(0.55);
    this.#rootIds.forEach((_, index) => {
      colors[index * 6] = start.r;
      colors[index * 6 + 1] = start.g;
      colors[index * 6 + 2] = start.b;
      colors[index * 6 + 3] = end.r;
      colors[index * 6 + 4] = end.g;
      colors[index * 6 + 5] = end.b;
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setAttribute("color", new BufferAttribute(colors, 3));
    this.#rootRayPositions = positions;
    this.#rootRays = new LineSegments(geometry, this.#rootRayMaterial);
    this.#rootRays.frustumCulled = false;
    this.#rootRays.renderOrder = -1;
    this.#scene.add(this.#rootRays);
    this.#syncRootRays();
  }

  #syncRootRays(): void {
    const rays = this.#rootRays;
    if (rays === null) return;
    this.#rootIds.forEach((id, index) => {
      const point = this.#current.get(id);
      if (point === undefined) return;
      const offset = index * 6;
      this.#rootRayPositions[offset] = 0;
      this.#rootRayPositions[offset + 1] = 0;
      this.#rootRayPositions[offset + 2] = 0;
      this.#rootRayPositions[offset + 3] = point.x;
      this.#rootRayPositions[offset + 4] = point.y;
      this.#rootRayPositions[offset + 5] = point.z;
    });
    rays.geometry.getAttribute("position").needsUpdate = true;
  }

  #isEdgeVisible(edge: OrbitSceneEdge): boolean {
    if (edge.primary) return true;
    return (
      edge.from === this.#hovered ||
      edge.to === this.#hovered ||
      (this.#selection.has(edge.from) && this.#selection.has(edge.to))
    );
  }

  #rebuildEdges(): void {
    if (this.#edgeLines !== null) {
      this.#scene.remove(this.#edgeLines);
      this.#edgeLines.geometry.dispose();
      this.#edgeLines = null;
    }
    this.#visibleEdges = this.#edges.filter((edge) => this.#isEdgeVisible(edge));
    if (this.#visibleEdges.length === 0) return;
    const positions = new Float32Array(this.#visibleEdges.length * 6);
    const colors = new Float32Array(this.#visibleEdges.length * 6);
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setAttribute("color", new BufferAttribute(colors, 3));
    this.#edgePositions = positions;
    this.#edgeLines = new LineSegments(geometry, this.#edgeMaterial);
    this.#edgeLines.frustumCulled = false;
    this.#scene.add(this.#edgeLines);
    this.#syncEdgePositions();
    this.#applyEdgeColors();
  }

  /** Upstream ends stay dim, downstream ends brighten: a lineage reads as a
   * faint starlight thread flowing outwards. */
  #applyEdgeColors(): void {
    const lines = this.#edgeLines;
    if (lines === null) return;
    const attribute = lines.geometry.getAttribute("color");
    if (attribute === undefined) return;
    const base = colorOf(this.#theme.edge);
    const highlight = colorOf(this.#theme.highlight);
    this.#visibleEdges.forEach((edge, index) => {
      const active =
        edge.from === this.#hovered ||
        edge.to === this.#hovered ||
        (this.#selection.has(edge.from) && this.#selection.has(edge.to));
      const weight = edge.primary ? 1 : 0.8;
      const upstream = base.clone().multiplyScalar(weight * 0.3);
      const downstream = base.clone().multiplyScalar(weight);
      if (active) {
        upstream.lerp(highlight, 0.55);
        downstream.lerp(highlight, 0.85);
      }
      attribute.setXYZ(index * 2, upstream.r, upstream.g, upstream.b);
      attribute.setXYZ(index * 2 + 1, downstream.r, downstream.g, downstream.b);
    });
    attribute.needsUpdate = true;
  }

  #syncEdgePositions(): void {
    const lines = this.#edgeLines;
    if (lines === null) return;
    this.#visibleEdges.forEach((edge, index) => {
      const from = this.#current.get(edge.from);
      const to = this.#current.get(edge.to);
      if (from === undefined || to === undefined) return;
      const offset = index * 6;
      this.#edgePositions[offset] = from.x;
      this.#edgePositions[offset + 1] = from.y;
      this.#edgePositions[offset + 2] = from.z;
      this.#edgePositions[offset + 3] = to.x;
      this.#edgePositions[offset + 4] = to.y;
      this.#edgePositions[offset + 5] = to.z;
    });
    const attribute = lines.geometry.getAttribute("position");
    attribute.needsUpdate = true;
  }

  #haloTargetScale(item: SceneItem, kind: HaloState["kind"]): number {
    return item.satellite === null ? HALO_SCALE.decision[kind] : HALO_SCALE.satellite[kind];
  }

  /** Reconcile the halo set with the interacted stars: every displayed copy
   * of a hovered or selected node gets one. Wanted halos grow, dropped ones
   * fade out in #applySmoothHalos instead of disappearing. */
  #rebuildHalos(): void {
    const wanted = new Map<string, HaloState["kind"]>();
    for (const item of this.#items) {
      if (this.#selection.has(item.id)) wanted.set(item.key, "selection");
      else if (item.id === this.#hovered) wanted.set(item.key, "hover");
    }
    for (const [key, halo] of this.#halos) {
      if (!wanted.has(key)) halo.target = 0;
    }
    for (const [key, kind] of wanted) {
      const item = this.#itemByKey.get(key);
      if (item === undefined) continue;
      const target = this.#haloTargetScale(item, kind);
      const existing = this.#halos.get(key);
      if (existing === undefined) {
        const position = this.#itemPosition(item);
        if (position === undefined) continue;
        const sprite = new Sprite(
          kind === "selection" ? this.#selectionMaterial : this.#hoverMaterial,
        );
        sprite.position.copy(position);
        sprite.scale.setScalar(ORBIT_STAR_RADIUS * HALO_MIN_SCALE);
        sprite.renderOrder = 2;
        this.#scene.add(sprite);
        this.#halos.set(key, {
          sprite,
          kind,
          scale: HALO_MIN_SCALE,
          target,
        });
        continue;
      }
      if (existing.kind !== kind) {
        existing.kind = kind;
        existing.sprite.material =
          kind === "selection" ? this.#selectionMaterial : this.#hoverMaterial;
      }
      existing.target = target;
    }
  }

  /** Perspective compensation for glow sprites: as the camera moves closer,
   * a world-sized glow grows logarithmically instead of linearly. */
  #glowScaleAt(position: Vector3): number {
    const depth = Math.max(this.#camera.position.distanceTo(position), 1e-3);
    // Distance and field of view both magnify the view; fold them into one
    // zoom ratio so a narrow FOV also grows the glow logarithmically.
    const half = (Math.PI / 180) * 0.5;
    const fovRatio = Math.tan(this.#fitFov * half) / Math.tan(this.#camera.fov * half);
    return logGlowScale((this.#fitReference / depth) * fovRatio);
  }

  /** Ease every halo towards its resting size; a dropped halo shrinks below
   * visibility and is then removed. */
  #applySmoothHalos(delta: number): boolean {
    if (this.#halos.size === 0) return false;
    const blend = easeBlend(delta, HALO_TAU_MS);
    let moving = false;
    for (const [key, halo] of [...this.#halos]) {
      const difference = halo.target - halo.scale;
      if (Math.abs(difference) > HALO_MIN_SCALE) {
        halo.scale += difference * blend;
        moving = true;
      } else {
        halo.scale = halo.target;
      }
      if (halo.target === 0 && halo.scale < HALO_MIN_SCALE * 2) {
        this.#scene.remove(halo.sprite);
        this.#halos.delete(key);
        continue;
      }
      const scale =
        ORBIT_STAR_RADIUS *
        Math.max(halo.scale, HALO_MIN_SCALE) *
        this.#glowScaleAt(halo.sprite.position);
      halo.sprite.scale.setScalar(scale);
    }
    return moving;
  }

  #syncHalos(): void {
    for (const [key, halo] of this.#halos) {
      const item = this.#itemByKey.get(key);
      if (item === undefined) continue;
      const position = this.#itemPosition(item);
      if (position !== undefined) halo.sprite.position.copy(position);
    }
  }

  /** Host whose ring the focus belongs to; undefined when nothing is shown. */
  #focusHost(): string | null | undefined {
    if (this.#focusKey === null) return undefined;
    if (this.#focusKey === ORBIT_ROOT_ID) return null;
    const satellite = this.#satellites.find((entry) => entry.key === this.#focusKey);
    return satellite === undefined ? this.#focusKey : satellite.host;
  }

  #focusPosition(): Vector3 | null {
    if (this.#focusKey === null) return null;
    if (this.#focusKey === ORBIT_ROOT_ID) return this.#origin;
    const satellite = this.#satellitePositions.get(this.#focusKey);
    if (satellite !== undefined) return satellite;
    return this.#current.get(this.#focusKey) ?? null;
  }

  /** Glide the orbit center onto the focused star, carrying the camera by
   * the same offset so the rotation distance and direction stay put. */
  #applySmoothCenter(delta: number): boolean {
    if (this.#focusKey === null) return false;
    const point = this.#focusPosition();
    if (point === null) {
      this.#focusKey = null;
      this.#rebuildTrack();
      return false;
    }
    const moving = glideCenter(
      this.#controls.target,
      this.#camera.position,
      point,
      easeBlend(delta, CENTER_TAU_MS),
    );
    if (moving) this.#notifyCamera();
    return moving;
  }

  /** Advance every satellite ring and recompute the satellite positions;
   * returns whether the rings are revolving. */
  #updateSatellitePositions(delta: number): boolean {
    let moving = false;
    for (const satellite of this.#satellites) {
      let angle = this.#satelliteAngles.get(satellite.key) ?? satellite.phase;
      if (delta > 0) {
        angle += SATELLITE_SPEED * delta;
        moving = true;
      }
      angle %= Math.PI * 2;
      this.#satelliteAngles.set(satellite.key, angle);
      const host = satellite.host === null ? this.#origin : this.#current.get(satellite.host);
      const position = this.#satellitePositions.get(satellite.key);
      if (host === undefined || position === undefined) continue;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      position.set(
        host.x + (cos * satellite.axisA.x + sin * satellite.axisB.x) * satellite.radius,
        host.y + (cos * satellite.axisA.y + sin * satellite.axisB.y) * satellite.radius,
        host.z + (cos * satellite.axisA.z + sin * satellite.axisB.z) * satellite.radius,
      );
    }
    return moving;
  }

  /** Interpolate every decision towards its target position; returns whether
   * anything is still moving. */
  #interpolate(delta: number): boolean {
    let moving = false;
    const blend = easeBlend(delta, POSITION_TAU_MS);
    for (const node of this.#decisions) {
      const current = this.#current.get(node.id);
      const target = this.#targets.get(node.id);
      if (current === undefined || target === undefined) continue;
      if (current.distanceToSquared(target) < 1e-8) current.copy(target);
      else {
        current.lerp(target, blend);
        moving = true;
      }
    }
    return moving;
  }

  /** Copy every item's current position into the point buffers and keep the
   * edges, root rays, halos and focused ring in step. */
  #writeItemPositions(): void {
    this.#decisions.forEach((node, index) => {
      const point = this.#current.get(node.id);
      if (point === undefined) return;
      this.#pointsPositions[index * 3] = point.x;
      this.#pointsPositions[index * 3 + 1] = point.y;
      this.#pointsPositions[index * 3 + 2] = point.z;
      this.#glowPositions[index * 3] = point.x;
      this.#glowPositions[index * 3 + 1] = point.y;
      this.#glowPositions[index * 3 + 2] = point.z;
    });
    const decisionPositions = this.#points?.geometry.getAttribute("position");
    if (decisionPositions !== undefined) decisionPositions.needsUpdate = true;
    const glowPositions = this.#glow?.geometry.getAttribute("position");
    if (glowPositions !== undefined) glowPositions.needsUpdate = true;
    this.#satellites.forEach((satellite, index) => {
      const point = this.#satellitePositions.get(satellite.key);
      if (point === undefined) return;
      this.#satelliteBuffer[index * 3] = point.x;
      this.#satelliteBuffer[index * 3 + 1] = point.y;
      this.#satelliteBuffer[index * 3 + 2] = point.z;
    });
    const satellitePositions = this.#satellitePoints?.geometry.getAttribute("position");
    if (satellitePositions !== undefined) satellitePositions.needsUpdate = true;
    this.#syncEdgePositions();
    this.#syncRootRays();
    this.#syncHalos();
    this.#syncTrack();
  }

  /** Rebuild the faint rings of every satellite in the focused system. */
  #rebuildTrack(): void {
    if (this.#track !== null) {
      this.#scene.remove(this.#track);
      this.#track.geometry.dispose();
      this.#track = null;
    }
    const host = this.#focusHost();
    if (host === undefined) return;
    const satellites = this.#satellites.filter((satellite) => satellite.host === host);
    if (satellites.length === 0) return;
    const segments = 120;
    const positions = new Float32Array(satellites.length * segments * 2 * 3);
    let offset = 0;
    for (const satellite of satellites) {
      for (let index = 0; index < segments; index++) {
        for (const angle of [
          (index / segments) * Math.PI * 2,
          ((index + 1) / segments) * Math.PI * 2,
        ]) {
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          positions[offset] =
            (cos * satellite.axisA.x + sin * satellite.axisB.x) * satellite.radius;
          positions[offset + 1] =
            (cos * satellite.axisA.y + sin * satellite.axisB.y) * satellite.radius;
          positions[offset + 2] =
            (cos * satellite.axisA.z + sin * satellite.axisB.z) * satellite.radius;
          offset += 3;
        }
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    this.#track = new LineSegments(geometry, this.#trackMaterial);
    this.#track.frustumCulled = false;
    this.#track.renderOrder = 1;
    this.#trackHost = host;
    this.#scene.add(this.#track);
    this.#syncTrack();
  }

  #syncTrack(): void {
    if (this.#track === null) return;
    if (this.#trackHost === null) {
      this.#track.visible = true;
      this.#track.position.set(0, 0, 0);
      return;
    }
    const host = this.#current.get(this.#trackHost);
    this.#track.visible = host !== undefined;
    if (host !== undefined) this.#track.position.copy(host);
  }

  /** Ease the virtual root's glow between its resting, hovered and focused
   * sizes; returns whether it is still changing. */
  #applyRootGlow(delta: number): boolean {
    const focused = this.#focusKey === ORBIT_ROOT_ID;
    const scaleTarget = focused
      ? ROOT_GLOW_FOCUS
      : this.#rootHovered
        ? ROOT_GLOW_HOVER
        : ROOT_GLOW_BASE;
    const opacityTarget = focused
      ? ROOT_OPACITY_FOCUS
      : this.#rootHovered
        ? ROOT_OPACITY_HOVER
        : ROOT_OPACITY_BASE;
    const blend = easeBlend(delta, HALO_TAU_MS);
    let moving = false;
    if (Math.abs(scaleTarget - this.#rootScale) > 1e-3) {
      this.#rootScale += (scaleTarget - this.#rootScale) * blend;
      moving = true;
    } else {
      this.#rootScale = scaleTarget;
    }
    if (Math.abs(opacityTarget - this.#rootOpacity) > 1e-3) {
      this.#rootOpacity += (opacityTarget - this.#rootOpacity) * blend;
      moving = true;
    } else {
      this.#rootOpacity = opacityTarget;
    }
    this.#root.scale.setScalar(
      ORBIT_ROOT_STAR_RADIUS * this.#rootScale * this.#glowScaleAt(this.#origin),
    );
    this.#rootMaterial.opacity = this.#rootOpacity;
    return moving;
  }

  #syncFog(): void {
    const fog = this.#scene.fog;
    if (!(fog instanceof Fog)) return;
    const distance = this.#camera.position.distanceTo(this.#controls.target);
    fog.near = distance * 0.95;
    fog.far = distance * 1.9;
  }

  #notifyCamera(): void {
    this.#cameraListener?.();
  }

  #queue(): void {
    if (this.#disposed || this.#frame !== 0) return;
    this.#frame = requestAnimationFrame(this.#tick);
  }

  #tick = (time: number): void => {
    this.#frame = 0;
    const delta = this.#lastTime === 0 ? 16 : Math.min(64, time - this.#lastTime);
    this.#lastTime = time;
    const moving = this.#interpolate(delta);
    const revolving = this.#updateSatellitePositions(delta);
    this.#writeItemPositions();
    const centering = this.#applySmoothCenter(delta);
    const glowing = this.#applySmoothHalos(delta);
    const rootGlow = this.#applyRootGlow(delta);
    const zooming = this.#applySmoothZoom(delta);
    const fovChanging = this.#applySmoothFov(delta);
    const cameraMoved = this.#controls.update();
    this.#syncFog();
    if (this.#width > 1) this.#renderer.render(this.#scene, this.#camera);
    this.#frameListener?.();
    if (
      moving ||
      revolving ||
      centering ||
      glowing ||
      rootGlow ||
      zooming ||
      fovChanging ||
      cameraMoved
    ) {
      this.#queue();
    } else {
      this.#lastTime = 0;
    }
  };
}
