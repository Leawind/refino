import { GlyphAtlas, quantizeRasterScale, wrapEllipsized } from "./atlas";
import {
  centeredCamera,
  fitCamera,
  focusFollow,
  pannedCamera as panCamera,
  zoomedCamera as zoomCamera,
  clampCamera,
  type Camera,
  type CameraBox,
  type Viewport,
} from "./camera";
import {
  COST_SHAPE_NODE,
  COST_TEXT_NODE,
  cullByBudget,
  REFERENCE_NODE_AREA,
  TEXT_LOD_SCREEN_H,
  type AdaptiveBudget,
  type CullEntry,
} from "./budget";
import { createProgram, EDGE_QUAD, type Program, UNIT_QUAD } from "./programs";

/**
 * WebGL2 canvas renderer for the working set (ui README, "画布"): batched
 * instanced drawing of nodes, edges and labels, with the render budget
 * culling over-budget nodes and the hover fade-in/out as per the display
 * rules. DOM floating controls stay outside this module.
 *
 * Frames render on damage only (scene/camera/theme changes, resize,
 * running fade animations); the render budget adapts while frames render
 * continuously. The viewport owns a current/target camera pair: inputs
 * (wheel zoom, left-drag pan) set clamped targets,
 * and the current camera glides towards them. The camera follows the focus
 * (camera.ts focusFollow) per the scene's policy: snapshot layouts
 * compensate relayout displacement so a clicked node stays put, while
 * converging layouts leave the viewport entirely to the user. At rest the
 * camera always satisfies the bounding-box constraints (README, "视口").
 */

export type RGBA = [number, number, number, number];

export interface ThemeColors {
  nodeBg: RGBA;
  nodeBorder: RGBA;
  edge: RGBA;
  primary: RGBA;
  text: RGBA;
  /** The canvas surface color, for premixing weakened premise variants. */
  canvasBg: RGBA;
}

/** A node as submitted by the component, in virtual layout coordinates. */
export interface RenderNodeInput {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  selected: boolean;
  focus: boolean;
  hovered: boolean;
  /** Premise nodes draw as weakened capsules (README, "显示规则与样式"). */
  premise: boolean;
  /** Render priority class (CULL_*), decided by the component. */
  cls: number;
  /** Distance to the nearest selected node, ordering within a class. */
  distance: number;
}

export interface RenderEdgeInput {
  fromId: string;
  toId: string;
  emphasized: boolean;
  /** Premise-ground edges draw thinner and weaker. */
  weak: boolean;
}

export interface SceneInput {
  nodes: RenderNodeInput[];
  edges: RenderEdgeInput[];
  /** The focus node (last of the selection); the camera follows it. */
  focusId: string | null;
  /** Focus camera policy: snapshot layouts ("pin") compensate relayout
   * displacement so the focus never moves on screen; converging layouts
   * ("none") leave the viewport entirely to the user. */
  focusFollow: "pin" | "none";
}

export interface RenderInfo {
  /** The last frame dropped nodes or edges to fit the render budget. */
  culled: boolean;
  /** Camera at frame end. */
  camera: { scale: number; tx: number; ty: number };
  /** Camera target at frame end. */
  target: { scale: number; tx: number; ty: number };
}

const FIT_MARGIN = 24;
/** Zoom factor per wheel notch unit; wheel zoom is multiplicative. */
const ZOOM_WHEEL_FACTOR = 0.0015;
/** Bounds of the text size multiplier (canvas style settings). */
export const TEXT_SCALE_MIN = 0.1;
export const TEXT_SCALE_MAX = 3;
/** Left-press movement beyond which the gesture is a pan, not a click. */
const CLICK_SLOP_PX = 2;
/** Camera smoothing: time constant of the exponential approach. */
const CAMERA_TAU_MS = 110;
/** Camera snap threshold. */
const CAMERA_EPSILON = 0.01;
// Geometry constants below are in virtual units: they scale with the
// viewport zoom like every canvas content (ui README, "视口").
const LABEL_FONT_PX = 12;
const LABEL_PAD_X = 10;
/** Vertical label padding and line height (in font-size units): a default
 * 150×44 card fits two 12px lines. */
const LABEL_PAD_Y = 4;
const LABEL_LINE_HEIGHT = 1.4;
const EDGE_WIDTH = 1.4;
const EDGE_WIDTH_EMPHASIZED = 2.4;
const EDGE_WIDTH_LOD = 1;
const BORDER_WIDTH = 1.2;
const BORDER_WIDTH_HOVERED = 2;
const BORDER_WIDTH_SELECTED = 2.4;
const BORDER_WIDTH_FOCUS = 3.2;
const CORNER_RADIUS = 8;
/** Fade fully in or out over ~180ms. */
const FADE_SPEED_PER_S = 1 / 0.18;

/** Parses "rgb(...)"/"rgba(...)" computed styles and #rgb/#rrggbb hex. */
export function parseColor(spec: string): RGBA {
  const hex = spec.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex !== null) {
    const digits = hex[1]!;
    const expanded = digits.length === 3 ? [...digits].map((ch) => ch + ch).join("") : digits;
    return [
      parseInt(expanded.slice(0, 2), 16) / 255,
      parseInt(expanded.slice(2, 4), 16) / 255,
      parseInt(expanded.slice(4, 6), 16) / 255,
      1,
    ];
  }
  const numbers = spec.match(/[\d.]+/g) ?? [];
  const at = (index: number): number => Number(numbers[index] ?? 0);
  return [at(0) / 255, at(1) / 255, at(2) / 255, numbers[3] !== undefined ? Number(numbers[3]) : 1];
}

/** Reads the canvas palette from the theme tokens on <html>. All values come
 * from custom properties: they flip instantly with the theme, unlike
 * computed properties (body color etc.) that the global transition keeps
 * animating for ~200ms after a flip. */
export function readThemeColors(): ThemeColors {
  const root = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string): RGBA =>
    parseColor(root.getPropertyValue(name) || fallback);
  return {
    nodeBg: token("--refino-node-bg", "#ffffff"),
    nodeBorder: token("--refino-node-border", "rgba(15, 23, 42, 0.3)"),
    edge: token("--refino-edge", "rgba(15, 23, 42, 0.35)"),
    primary: token("--refino-primary", "#18a058"),
    text: token("--refino-node-text", "rgba(0, 0, 0, 0.9)"),
    canvasBg: token("--refino-canvas-bg", "#f7f8fa"),
  };
}

/** Straight-alpha mix of a color towards the canvas surface by `t`. */
function premix(color: RGBA, canvasBg: RGBA, t: number): RGBA {
  return [
    color[0] + (canvasBg[0] - color[0]) * t,
    color[1] + (canvasBg[1] - color[1]) * t,
    color[2] + (canvasBg[2] - color[2]) * t,
    color[3] * (1 - t * 0.55),
  ];
}

interface Entry {
  node: RenderNodeInput;
  alpha: number;
  target: number;
}

/** The point where the segment c -> t exits the rounded rect centered at c
 * with the given half sizes and corner radius; c itself when the segment is
 * degenerate. Rays from the center cross the straight-edge midsections
 * exactly where they would cross the sharp-cornered rect; only directions
 * through a corner square hit the corner arc instead, so shaft ends and
 * arrow tips hug the rounded outline (capsules, in particular). */
export function borderPoint(
  cx: number,
  cy: number,
  tx: number,
  ty: number,
  hw: number,
  hh: number,
  radius: number,
): [number, number] {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const r = Math.min(radius, hw, hh);
  // Axial directions hit a straight midsection head-on.
  if (r <= 0 || ax === 0 || ay === 0) {
    const sx = ax !== 0 ? hw / ax : Number.POSITIVE_INFINITY;
    const sy = ay !== 0 ? hh / ay : Number.POSITIVE_INFINITY;
    const s = Math.min(sx, sy);
    if (!Number.isFinite(s)) return [cx, cy];
    return [cx + dx * s, cy + dy * s];
  }
  const cw = hw - r; // straight-edge zone half sizes ("core" rect)
  const ch = hh - r;
  // The sharp-cornered intersection lands on a real straight-edge midsection
  // unless its off-axis coordinate reaches into a corner square.
  const sEdge = Math.min(hw / ax, hh / ay);
  const exitsXFirst = hw / ax <= hh / ay;
  const onStraight = exitsXFirst ? ay * sEdge <= ch : ax * sEdge <= cw;
  if (onStraight) return [cx + dx * sEdge, cy + dy * sEdge];
  // Corner direction: intersect the ray with the corner arc, the circle of
  // radius r around the core corner in the ray's quadrant. The ray starts
  // inside that circle (the corner square), so the exit is the far root.
  const len = Math.hypot(dx, dy);
  const nx = dx / len;
  const ny = dy / len;
  const ox = Math.sign(dx) * cw;
  const oy = Math.sign(dy) * ch;
  const b = nx * ox + ny * oy; // unit ray · circle-center offset
  const disc = b * b - (cw * cw + ch * ch - r * r);
  if (disc < 0) return [cx + dx * sEdge, cy + dy * sEdge]; // numerically unreachable
  const t = b + Math.sqrt(disc);
  return [cx + nx * t, cy + ny * t];
}

function grow(source: Float32Array): Float32Array<ArrayBuffer> {
  const grown = new Float32Array(source.length * 2);
  grown.set(source);
  return grown;
}

export class GraphRenderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #gl: WebGL2RenderingContext;
  #budget: AdaptiveBudget;
  readonly #atlas = new GlyphAtlas();
  // GL resources are created in #initGl (constructor and context restore);
  // the assertions stand in for the compiler's constructor-only analysis.
  #atlasTexture!: WebGLTexture;
  #atlasVersion = -1;

  #entries = new Map<string, Entry>();
  #edges: RenderEdgeInput[] = [];
  #admitted = new Set<string>();
  #culled = false;
  #labelCache = new Map<string, string[]>();

  #theme: ThemeColors = {
    nodeBg: [1, 1, 1, 1],
    nodeBorder: [0.06, 0.09, 0.16, 0.3],
    edge: [0.06, 0.09, 0.16, 0.35],
    primary: [0.09, 0.63, 0.35, 1],
    text: [0.1, 0.1, 0.1, 0.9],
    canvasBg: [0.97, 0.97, 0.98, 1],
  };
  #camera: Camera = { scale: 1, tx: 0, ty: 0 };
  #target: Camera = { scale: 1, tx: 0, ty: 0 };
  #maxScale = 4;
  /** Text size multiplier on top of the camera scale (style settings). */
  #textScale = 1;
  /** Current node card footprint for the budget estimate. */
  #nodeArea = REFERENCE_NODE_AREA;
  #zoomAnchor: "cursor" | "center" = "cursor";
  #cssWidth = 0;
  #cssHeight = 0;
  /** Active left-button gesture; `moved` says whether it left the click
   * slop (and so suppresses the click that follows its mouseup). */
  #gesture: {
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
  } | null = null;
  #clickSuppressed = false;
  #lastFocusId: string | null = null;
  /** Node-drag gesture (force layouts): non-null while a left press on a
   * node is dragging it instead of panning. The offsets keep the node at
   * its grab position relative to the pointer for the whole gesture. */
  #nodeDrag: {
    id: string;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
  } | null = null;
  #nodeDragHandler: ((id: string, x: number, y: number, phase: "drag" | "end") => void) | null =
    null;

  #edgeProgram!: Program;
  #nodeProgram!: Program;
  #textProgram!: Program;
  #edgeVao!: WebGLVertexArrayObject;
  #nodeVao!: WebGLVertexArrayObject;
  #textVao!: WebGLVertexArrayObject;
  #edgeInstances!: WebGLBuffer;
  #nodeInstances!: WebGLBuffer;
  #textInstances!: WebGLBuffer;
  #edgeData = new Float32Array(9 * 64);
  #nodeData = new Float32Array(15 * 64);
  #textData = new Float32Array(9 * 256);

  #raf = 0;
  #lastRenderedAt = 0;
  #frameEnd: ((info: RenderInfo) => void) | null = null;
  #resizeObserver: ResizeObserver;
  #lost = false;

  /** Called after every rendered frame. */
  set onFrameEnd(handler: ((info: RenderInfo) => void) | null) {
    this.#frameEnd = handler;
  }

  /** Sets the node-drag handler: when present, a left press on a node
   * drags the node (phase "drag" carries its virtual position; "end"
   * signals release) instead of panning. Pass null to restore pan
   * everywhere. */
  setNodeDragHandler(
    handler: ((id: string, x: number, y: number, phase: "drag" | "end") => void) | null,
  ): void {
    this.#nodeDragHandler = handler;
  }

  static create(canvas: HTMLCanvasElement, budget: AdaptiveBudget): GraphRenderer | null {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      // The frame is damage-driven; keeping the buffer means hosts can
      // snapshot the canvas outside the drawing frame.
      preserveDrawingBuffer: true,
    });
    if (gl === null) return null;
    try {
      return new GraphRenderer(canvas, gl, budget);
    } catch (error) {
      // A failed program leaves the canvas blank with no signal; surface it
      // and let the component fall back to its DOM message.
      console.error("graph renderer initialization failed", error);
      return null;
    }
  }

  private constructor(
    canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
    budget: AdaptiveBudget,
  ) {
    this.#canvas = canvas;
    this.#gl = gl;
    this.#budget = budget;

    this.#initGl();

    canvas.addEventListener("webglcontextlost", this.#onContextLost);
    canvas.addEventListener("webglcontextrestored", this.#onContextRestored);
    // Wheel zooms the viewport (README, "视口") and may never page-zoom;
    // left-drag pans 1:1 and suppresses the click
    // that follows a gesture beyond the click slop.
    canvas.addEventListener("wheel", this.#onWheel, { passive: false });
    canvas.addEventListener("mousedown", this.#onMouseDown);
    window.addEventListener("mousemove", this.#onMouseMove);
    window.addEventListener("mouseup", this.#onMouseUp);
    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(canvas);
    this.#resize();
  }

  /**
   * Create every GL resource: the three programs, the glyph atlas texture
   * and the per-program VAOs with their instance buffers. Runs once from the
   * constructor and again after a context restore — a restored context is
   * fresh, with all previous programs, buffers and textures invalidated.
   * The CPU-side instance arrays survive and are re-uploaded per frame.
   */
  #initGl(): void {
    const gl = this.#gl;
    this.#edgeProgram = createProgram(gl, "edge");
    this.#nodeProgram = createProgram(gl, "node");
    this.#textProgram = createProgram(gl, "text");
    this.#atlasTexture = gl.createTexture()!;
    this.#initAtlasTexture();

    const edgeDraw = this.#makeVao(EDGE_QUAD, this.#edgeData.length, [
      [2, 0],
      [2, 2],
      [1, 4],
      [4, 5],
    ]);
    this.#edgeVao = edgeDraw.vao;
    this.#edgeInstances = edgeDraw.buffer;
    const nodeDraw = this.#makeVao(UNIT_QUAD, this.#nodeData.length, [
      [2, 0],
      [2, 2],
      [1, 4],
      [1, 5],
      [4, 6],
      [4, 10],
      [1, 14],
    ]);
    this.#nodeVao = nodeDraw.vao;
    this.#nodeInstances = nodeDraw.buffer;
    const textDraw = this.#makeVao(UNIT_QUAD, this.#textData.length, [
      [2, 0],
      [2, 2],
      [2, 4],
      [2, 6],
      [1, 8],
    ]);
    this.#textVao = textDraw.vao;
    this.#textInstances = textDraw.buffer;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
  }

  /** Replaces the whole display list; takes effect on the next frame. */
  setScene(scene: SceneInput): void {
    // Focus continuity across this update: the pre-update center of the
    // focus node, read before the loop below swaps in new geometry.
    const previousId = this.#lastFocusId;
    const previousEntry = previousId !== null ? this.#entries.get(previousId) : undefined;
    const previousCenter =
      previousEntry === undefined
        ? null
        : {
            x: previousEntry.node.x + previousEntry.node.width / 2,
            y: previousEntry.node.y + previousEntry.node.height / 2,
          };
    const seen = new Set<string>();
    for (const node of scene.nodes) {
      seen.add(node.id);
      const entry = this.#entries.get(node.id);
      if (entry !== undefined) {
        entry.node = node;
        entry.target = 1;
      } else {
        // Nodes appear at once so the first frame is complete even under
        // rAF throttling. The fade-out reuses the last known geometry.
        this.#entries.set(node.id, { node, alpha: 1, target: 1 });
      }
    }
    for (const entry of this.#entries.values()) {
      if (!seen.has(entry.node.id)) entry.target = 0;
    }
    this.#edges = scene.edges;

    // The camera follows the focus (README: 相机随焦点): it flies to an
    // off-screen or newly joining focus and compensates a relayout that
    // displaces an unchanged focus, so a canvas click never moves the
    // clicked node. The focus id and the focus node's scene entry change in
    // different ticks — the working set arrives asynchronously after the
    // selection — and the follow decision covers both transitions.
    this.#lastFocusId = scene.focusId;
    const current = scene.focusId !== null ? this.#entries.get(scene.focusId) : undefined;
    const follow = focusFollow({
      previousId,
      currentId: scene.focusId,
      previousCenter,
      rect:
        current === undefined
          ? null
          : {
              x: current.node.x,
              y: current.node.y,
              width: current.node.width,
              height: current.node.height,
            },
      viewport: this.#viewport(),
      camera: this.#camera,
      mode: scene.focusFollow,
    });
    if (follow.action === "fly") this.#flyTo(scene.focusId);
    else if (follow.action === "compensate") this.#compensateFocus(follow.dx, follow.dy);
    this.#schedule();
  }

  /** Center the node on the viewport (no-op when it is not in the scene). */
  #flyTo(id: string | null): void {
    if (id === null) return;
    const entry = this.#entries.get(id);
    if (entry === undefined) return; // not in the working set (yet)
    const box = this.#contentBox();
    if (box === null) return;
    this.#target = centeredCamera(
      { x: entry.node.x + entry.node.width / 2, y: entry.node.y + entry.node.height / 2 },
      this.#viewport(),
      this.#camera,
      box,
      this.#maxScale,
    );
  }

  /** Pans both cameras by the inverse of the focus node's virtual
   * displacement so the node keeps its screen position (README: 相机补偿
   * 焦点的位移). Both move at once — the relayout itself is instantaneous,
   * and a gliding correction would drag the focus along. */
  #compensateFocus(dx: number, dy: number): void {
    const box = this.#contentBox();
    if (box === null) return;
    const viewport = this.#viewport();
    this.#camera = panCamera(
      this.#camera,
      -dx * this.#camera.scale,
      -dy * this.#camera.scale,
      viewport,
      box,
    );
    this.#target = panCamera(
      this.#target,
      -dx * this.#target.scale,
      -dy * this.#target.scale,
      viewport,
      box,
    );
  }

  /** Moves the camera so the whole working set fits with a margin; called
   * when the direction flips, never per working-set change (that would
   * defeat the stable layout). */
  fitToContent(): void {
    const box = this.#contentBox();
    if (box === null) return;
    this.#target = fitCamera(box, this.#viewport(), this.#maxScale, FIT_MARGIN);
    this.#schedule();
  }

  setZoomAnchor(anchor: "cursor" | "center"): void {
    this.#zoomAnchor = anchor;
  }

  setMaxScale(maxScale: number): void {
    this.#maxScale = Math.max(0.1, maxScale);
  }

  /** Sets the text size multiplier on top of the camera scale. */
  setTextScale(scale: number): void {
    this.#textScale = Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, scale));
    this.#schedule();
  }

  /** Updates the reference node footprint for the budget estimate (the
   * card size is configurable); reestimates against the current viewport. */
  setNodeArea(area: number): void {
    this.#nodeArea = area;
    this.#budget.reestimate(this.#viewport(), area);
  }

  #viewport(): Viewport {
    return { width: this.#cssWidth, height: this.#cssHeight };
  }

  /** Union bounding box of everything laid out; null while empty. */
  #contentBox(): CameraBox | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const entry of this.#entries.values()) {
      minX = Math.min(minX, entry.node.x);
      minY = Math.min(minY, entry.node.y);
      maxX = Math.max(maxX, entry.node.x + entry.node.width);
      maxY = Math.max(maxY, entry.node.y + entry.node.height);
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  }

  #onWheel = (event: WheelEvent): void => {
    // Wheel zooms the viewport and never page-zooms (README, "视口").
    // Multiplicative zoom keeps the gesture linear in perceived scale.
    event.preventDefault();
    const box = this.#contentBox();
    if (box === null) return;
    const rect = this.#canvas.getBoundingClientRect();
    const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    this.#target = zoomCamera(
      this.#target,
      Math.exp(-event.deltaY * ZOOM_WHEEL_FACTOR),
      this.#zoomAnchor === "cursor" ? anchor : null,
      this.#viewport(),
      box,
      this.#maxScale,
    );
    this.#schedule();
  };

  #onMouseDown = (event: MouseEvent): void => {
    if (event.button === 1) {
      event.preventDefault(); // no middle-click autoscroll
      return;
    }
    if (event.button !== 0) return;
    event.preventDefault();
    // A press on a node starts a node drag (force layouts); a press on
    // empty space pans the viewport. The grab offset (pointer minus node
    // corner, in virtual units) is remembered so the node keeps its exact
    // position relative to the pointer for the whole gesture.
    if (this.#nodeDragHandler !== null) {
      const rect = this.#canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const id = this.pick(px, py);
      if (id !== null) {
        const entry = this.#entries.get(id)!;
        const vx = (px - this.#camera.tx) / this.#camera.scale;
        const vy = (py - this.#camera.ty) / this.#camera.scale;
        this.#nodeDrag = {
          id,
          startX: event.clientX,
          startY: event.clientY,
          offsetX: vx - entry.node.x,
          offsetY: vy - entry.node.y,
        };
        this.#clickSuppressed = false;
        this.#canvas.style.cursor = "grabbing";
        return;
      }
    }
    this.#clickSuppressed = false;
    this.#gesture = {
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
    };
    this.#canvas.style.cursor = "grabbing";
  };

  #onMouseMove = (event: MouseEvent): void => {
    const drag = this.#nodeDrag;
    if (drag !== null) {
      // The pointer carries the node 1:1 in virtual coordinates, keeping
      // the grab offset; moving beyond the click slop makes the gesture a
      // drag, not a selection.
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > CLICK_SLOP_PX) {
        this.#clickSuppressed = true;
      }
      const rect = this.#canvas.getBoundingClientRect();
      const vx = (event.clientX - rect.left - this.#camera.tx) / this.#camera.scale;
      const vy = (event.clientY - rect.top - this.#camera.ty) / this.#camera.scale;
      this.#nodeDragHandler?.(drag.id, vx - drag.offsetX, vy - drag.offsetY, "drag");
      return;
    }
    const gesture = this.#gesture;
    if (gesture === null) return;
    const box = this.#contentBox();
    if (box === null) return;
    // Dragging is 1:1 (no smoothing lag): content follows the cursor.
    const dx = event.clientX - gesture.lastX;
    const dy = event.clientY - gesture.lastY;
    gesture.lastX = event.clientX;
    gesture.lastY = event.clientY;
    if (!gesture.moved) {
      const total = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
      if (total > CLICK_SLOP_PX) {
        gesture.moved = true;
        this.#clickSuppressed = true;
      }
    }
    const moved = panCamera(this.#camera, dx, dy, this.#viewport(), box);
    this.#camera = moved;
    this.#target = panCamera(this.#target, dx, dy, this.#viewport(), box);
    this.#schedule();
  };

  #onMouseUp = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    if (this.#nodeDrag !== null) {
      const drag = this.#nodeDrag;
      this.#nodeDrag = null;
      this.#canvas.style.cursor = "default";
      // Only a real drag ends in a release; a plain click passes through
      // to the selection handler untouched.
      if (this.#clickSuppressed) {
        this.#nodeDragHandler?.(drag.id, 0, 0, "end");
        this.#clickSuppressed = false;
      }
      return;
    }
    if (this.#gesture === null) return;
    this.#gesture = null;
    this.#canvas.style.cursor = "default";
  };

  /** True when the left press that just ended moved beyond the click slop:
   * the browser click that follows it must be ignored (README: 超过阈值视为
   * 拖拽，不触发点击). Resets on the next press. */
  get clickSuppressed(): boolean {
    return this.#clickSuppressed;
  }

  /** True while a left-button pan gesture is in progress. */
  get dragging(): boolean {
    return this.#gesture !== null;
  }

  setTheme(colors: ThemeColors): void {
    this.#theme = colors;
    this.#schedule();
  }

  /** Virtual-space node id under the CSS point, or null. */
  pick(cssX: number, cssY: number): string | null {
    const vx = (cssX - this.#camera.tx) / this.#camera.scale;
    const vy = (cssY - this.#camera.ty) / this.#camera.scale;
    for (const [id, entry] of this.#entries) {
      if (entry.alpha < 0.1 || !this.#admitted.has(id)) continue;
      const node = entry.node;
      if (vx >= node.x && vx <= node.x + node.width && vy >= node.y && vy <= node.y + node.height) {
        return id;
      }
    }
    return null;
  }

  requestRender(): void {
    this.#schedule();
  }

  dispose(): void {
    if (this.#raf !== 0) cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.#resizeObserver.disconnect();
    this.#canvas.removeEventListener("wheel", this.#onWheel);
    this.#canvas.removeEventListener("mousedown", this.#onMouseDown);
    window.removeEventListener("mousemove", this.#onMouseMove);
    window.removeEventListener("mouseup", this.#onMouseUp);
    this.#canvas.removeEventListener("webglcontextlost", this.#onContextLost);
    this.#canvas.removeEventListener("webglcontextrestored", this.#onContextRestored);
    this.#gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  #onContextLost = (event: Event): void => {
    event.preventDefault();
    this.#lost = true;
  };

  #onContextRestored = (): void => {
    // A restored context lost every program, buffer and texture; rebuild
    // them before drawing again. A failed rebuild keeps frames suspended
    // (the same blank-canvas fallback as a failed initial creation).
    try {
      this.#initGl();
    } catch (error) {
      console.error("graph renderer context restore failed", error);
      this.#lost = true;
      return;
    }
    this.#lost = false;
    this.#schedule();
  };

  #resize(): void {
    const width = this.#canvas.clientWidth;
    const height = this.#canvas.clientHeight;
    if (width === 0 || height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const deviceWidth = Math.round(width * dpr);
    const deviceHeight = Math.round(height * dpr);
    this.#cssWidth = width;
    this.#cssHeight = height;
    if (this.#canvas.width !== deviceWidth || this.#canvas.height !== deviceHeight) {
      this.#canvas.width = deviceWidth;
      this.#canvas.height = deviceHeight;
    }
    this.#budget.reestimate({ width, height }, this.#nodeArea);
    const box = this.#contentBox();
    if (box !== null) {
      this.#camera = clampCamera(this.#camera, box, this.#viewport());
      this.#target = clampCamera(this.#target, box, this.#viewport());
    }
    this.#schedule();
  }

  #schedule(): void {
    if (this.#raf !== 0 || this.#lost) return;
    this.#raf = requestAnimationFrame((now) => {
      this.#raf = 0;
      this.#frame(now);
    });
  }

  #frame(now: number): void {
    if (this.#lost || this.#cssWidth === 0) return;
    // Frame-time adaptation only over sustained rendering (a single damage
    // frame says nothing about throughput).
    if (this.#lastRenderedAt !== 0) {
      const delta = now - this.#lastRenderedAt;
      if (delta < 100) this.#budget.reportFrame(delta);
    }

    const settling = this.#tweenAlphas(now);
    const animating = this.#animateCamera(now) || settling;
    this.#cullAndDraw();
    if (animating) this.#schedule();
  }

  /** Advances hover fade-in/out; true while any alpha is still settling.
   * A backgrounded pane throttles rAF, so hidden documents snap instead of
   * freezing halfway. */
  #tweenAlphas(now: number): boolean {
    let animating = false;
    if (document.hidden) {
      for (const entry of this.#entries.values()) {
        entry.alpha = entry.target;
      }
      return false;
    }
    const dt =
      this.#lastRenderedAt === 0
        ? FADE_SPEED_PER_S * 16
        : Math.min(100, now - this.#lastRenderedAt);
    const step = FADE_SPEED_PER_S * (dt / 1000);
    for (const [id, entry] of this.#entries) {
      if (entry.alpha === entry.target) continue;
      const delta = entry.target - entry.alpha;
      entry.alpha += Math.sign(delta) * Math.min(Math.abs(delta), step);
      if (entry.alpha === entry.target && entry.target === 0) this.#entries.delete(id);
      else animating = true;
    }
    return animating;
  }

  /** Exponential approach of the current camera towards the target; true
   * while still gliding. */
  #animateCamera(now: number): boolean {
    const dt =
      this.#lastRenderedAt === 0 ? CAMERA_TAU_MS : Math.min(200, now - this.#lastRenderedAt);
    const blend = 1 - Math.exp(-dt / CAMERA_TAU_MS);
    let moving = false;
    for (const key of ["scale", "tx", "ty"] as const) {
      const delta = this.#target[key] - this.#camera[key];
      if (Math.abs(delta) < CAMERA_EPSILON) {
        this.#camera[key] = this.#target[key];
      } else {
        this.#camera[key] += delta * blend;
        moving = true;
      }
    }
    return moving;
  }

  #cullAndDraw(): void {
    const gl = this.#gl;
    const budget = this.#budget.current();
    const scale = this.#camera.scale;
    // Edge simplification keys off the smallest card on screen (the card
    // size is configurable), not a hardcoded reference height.
    let minHeight = Infinity;
    for (const entry of this.#entries.values()) {
      minHeight = Math.min(minHeight, entry.node.height);
    }
    const lowLod = minHeight * scale < TEXT_LOD_SCREEN_H;

    const cullEntries: CullEntry[] = [];
    const textShown = new Map<string, boolean>();
    for (const [id, entry] of this.#entries) {
      const withText = entry.node.height * scale >= TEXT_LOD_SCREEN_H && entry.node.label !== "";
      textShown.set(id, withText);
      cullEntries.push({
        id,
        cost: withText ? COST_TEXT_NODE : COST_SHAPE_NODE,
        cls: entry.node.cls,
        distance: entry.node.distance,
      });
    }
    const result = cullByBudget(cullEntries, this.#edges, budget);
    this.#admitted = result.admitted;
    this.#culled = result.culled;

    gl.viewport(0, 0, this.#canvas.width, this.#canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this.#drawEdges(lowLod, result.edges);
    this.#drawNodes();
    this.#drawText(textShown);

    this.#frameEnd?.({
      culled: this.#culled,
      camera: { ...this.#camera },
      target: { ...this.#target },
    });
  }

  #drawEdges(lowLod: boolean, enabled: Set<string>): void {
    const gl = this.#gl;
    const scale = this.#camera.scale;
    const tx = this.#camera.tx;
    const ty = this.#camera.ty;
    let count = 0;
    for (const edge of this.#edges) {
      if (!enabled.has(`${edge.fromId}\u0000${edge.toId}`)) continue;
      const from = this.#entries.get(edge.fromId);
      const to = this.#entries.get(edge.toId);
      if (from === undefined || to === undefined) continue;
      if (from.alpha < 0.02 || to.alpha < 0.02) continue;
      if ((count + 1) * 9 > this.#edgeData.length) this.#edgeData = grow(this.#edgeData);
      const width =
        (edge.emphasized ? EDGE_WIDTH_EMPHASIZED : lowLod ? EDGE_WIDTH_LOD : EDGE_WIDTH) *
        (edge.weak ? 0.75 : 1);
      const baseColor = edge.emphasized ? this.#theme.primary : this.#theme.edge;
      const color = edge.weak ? premix(baseColor, this.#theme.canvasBg, 0.4) : baseColor;
      const base = count * 9;
      // Trim both ends to the node outlines: the shaft must not run under
      // the opaque cards, and the arrow tip lands on the downstream border
      // (rounded corners and capsule shapes included).
      const fx = from.node.x + from.node.width / 2;
      const fy = from.node.y + from.node.height / 2;
      const sx = to.node.x + to.node.width / 2;
      const sy = to.node.y + to.node.height / 2;
      const fromRadius = from.node.premise ? from.node.height / 2 : CORNER_RADIUS;
      const toRadius = to.node.premise ? to.node.height / 2 : CORNER_RADIUS;
      const [x1, y1] = borderPoint(
        fx,
        fy,
        sx,
        sy,
        from.node.width / 2,
        from.node.height / 2,
        fromRadius,
      );
      const [x2, y2] = borderPoint(sx, sy, fx, fy, to.node.width / 2, to.node.height / 2, toRadius);
      // Instances are submitted in virtual coordinates; the vertex shader
      // applies the camera.
      this.#edgeData[base] = x1;
      this.#edgeData[base + 1] = y1;
      this.#edgeData[base + 2] = x2;
      this.#edgeData[base + 3] = y2;
      this.#edgeData[base + 4] = width;
      this.#edgeData.set(color, base + 5);
      count++;
    }

    const { program, uniform } = this.#edgeProgram;
    gl.useProgram(program);
    gl.uniform2f(uniform("u_resolution"), this.#canvas.width, this.#canvas.height);
    gl.uniform1f(uniform("u_dpr"), window.devicePixelRatio || 1);
    gl.uniform1f(uniform("u_scale"), scale);
    gl.uniform2f(uniform("u_offset"), tx, ty);
    // Near-parallel grounds converge on the same border point; the depth
    // test keeps the first edge's solid pixels from being re-blended by the
    // others' rims (the fragment stage discards sub-0.5 coverage). Nodes
    // and text draw afterwards without depth, as before.
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.bindVertexArray(this.#edgeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#edgeInstances);
    gl.bufferData(gl.ARRAY_BUFFER, this.#edgeData.slice(0, count * 9), gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
  }

  #drawNodes(): void {
    const gl = this.#gl;
    const scale = this.#camera.scale;
    const tx = this.#camera.tx;
    const ty = this.#camera.ty;
    let count = 0;
    for (const [id, entry] of this.#entries) {
      if (entry.alpha < 0.01 || !this.#admitted.has(id)) continue;
      if ((count + 1) * 15 > this.#nodeData.length) this.#nodeData = grow(this.#nodeData);
      const node = entry.node;
      // The ordinary / hovered / selected / focus states differ only in the
      // border — width and color here, no in-card badges (DESIGN.md).
      const emphasized = node.selected || node.focus || node.hovered;
      const borderWidth = node.focus
        ? BORDER_WIDTH_FOCUS
        : node.selected
          ? BORDER_WIDTH_SELECTED
          : node.hovered
            ? BORDER_WIDTH_HOVERED
            : BORDER_WIDTH;
      const borderColor = emphasized
        ? this.#theme.primary
        : node.premise
          ? premix(this.#theme.nodeBorder, this.#theme.canvasBg, 0.4)
          : this.#theme.nodeBorder;
      const base = count * 15;
      // Everything is virtual; the vertex shader applies the camera.
      this.#nodeData[base] = node.x + node.width / 2;
      this.#nodeData[base + 1] = node.y + node.height / 2;
      this.#nodeData[base + 2] = node.width;
      this.#nodeData[base + 3] = node.height;
      // Premises render as capsules — the fragment shader clamps the radius
      // to the half size, so the full half-height is safe to submit.
      this.#nodeData[base + 4] = node.premise ? node.height / 2 : CORNER_RADIUS;
      this.#nodeData[base + 5] = borderWidth;
      this.#nodeData.set(
        node.premise && !emphasized
          ? premix(this.#theme.nodeBg, this.#theme.canvasBg, 0.45)
          : this.#theme.nodeBg,
        base + 6,
      );
      this.#nodeData.set(borderColor, base + 10);
      this.#nodeData[base + 14] = entry.alpha;
      count++;
    }

    const { program, uniform } = this.#nodeProgram;
    gl.useProgram(program);
    gl.uniform2f(uniform("u_resolution"), this.#canvas.width, this.#canvas.height);
    gl.uniform1f(uniform("u_dpr"), window.devicePixelRatio || 1);
    gl.uniform1f(uniform("u_scale"), scale);
    gl.uniform2f(uniform("u_offset"), tx, ty);
    gl.bindVertexArray(this.#nodeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#nodeInstances);
    gl.bufferData(gl.ARRAY_BUFFER, this.#nodeData.slice(0, count * 16), gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    gl.bindVertexArray(null);
  }

  #drawText(textShown: Map<string, boolean>): void {
    const gl = this.#gl;
    if (this.#atlas.full) this.#atlas.reset(); // refill from scratch this frame

    const scale = this.#camera.scale;
    const tx = this.#camera.tx;
    const ty = this.#camera.ty;
    // Glyphs rasterize at roughly the size they appear on screen (quantized
    // tiers, switched with an atlas reset): magnified labels stay sharp
    // instead of smearing fixed-size bitmaps.
    this.#atlas.setRasterScale(quantizeRasterScale(scale * this.#textScale));
    // Glyph metrics are resolved in virtual units so glyph quads are
    // submitted like every other geometry; the text size multiplier
    // resizes text on top of the camera (README: 文本随视口缩放).
    const fontUnits = LABEL_FONT_PX * this.#textScale;
    const padUnits = LABEL_PAD_X * this.#textScale;
    const padYUnits = LABEL_PAD_Y * this.#textScale;
    const glyphUnits = fontUnits / this.#atlas.fontPx; // atlas font pixels → virtual units
    const lineHeight = fontUnits * LABEL_LINE_HEIGHT;
    let count = 0;
    for (const [id, entry] of this.#entries) {
      if (entry.alpha < 0.02 || !this.#admitted.has(id) || !textShown.get(id)) continue;
      const node = entry.node;
      const maxWidth = (node.width - padUnits * 2) / glyphUnits;
      const maxLines = Math.max(1, Math.floor((node.height - padYUnits * 2) / lineHeight));
      const lines = this.#linesFor(node.label, maxWidth, maxLines);
      // The wrapped lines are centered on the node as a block; `0.35`
      // shifts a line's baseline from its box center to the text middle.
      const firstBaseline =
        node.y + node.height / 2 - ((lines.length - 1) * lineHeight) / 2 + fontUnits * 0.35;
      for (let line = 0; line < lines.length; line++) {
        let penX = node.x + padUnits;
        const baseline = firstBaseline + line * lineHeight;
        for (const ch of lines[line]!) {
          const glyph = this.#atlas.glyph(ch);
          if (glyph === undefined) break; // atlas ran full; retries next frame
          if ((count + 1) * 9 > this.#textData.length) this.#textData = grow(this.#textData);
          if (glyph.width > 0) {
            const base = count * 9;
            this.#textData[base] = penX;
            this.#textData[base + 1] = baseline - glyph.ascent * glyphUnits;
            this.#textData[base + 2] = glyph.width * glyphUnits;
            this.#textData[base + 3] = glyph.height * glyphUnits;
            this.#textData[base + 4] = glyph.u0;
            this.#textData[base + 5] = glyph.v0;
            this.#textData[base + 6] = glyph.u1 - glyph.u0;
            this.#textData[base + 7] = glyph.v1 - glyph.v0;
            this.#textData[base + 8] = entry.alpha;
            count++;
          }
          penX += glyph.advance * glyphUnits;
        }
      }
    }

    // Rasterization above may have grown the atlas; one upload covers it all.
    if (this.#atlas.version !== this.#atlasVersion) this.#uploadAtlas();
    const { program, uniform } = this.#textProgram;
    gl.useProgram(program);
    gl.uniform2f(uniform("u_resolution"), this.#canvas.width, this.#canvas.height);
    gl.uniform1f(uniform("u_dpr"), window.devicePixelRatio || 1);
    gl.uniform1f(uniform("u_scale"), scale);
    gl.uniform2f(uniform("u_offset"), tx, ty);
    gl.uniform4fv(uniform("u_color"), this.#theme.text);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#atlasTexture);
    gl.uniform1i(uniform("u_atlas"), 0);
    gl.bindVertexArray(this.#textVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#textInstances);
    gl.bufferData(gl.ARRAY_BUFFER, this.#textData.slice(0, count * 9), gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    gl.bindVertexArray(null);
  }

  #linesFor(label: string, maxWidth: number, maxLines: number): string[] {
    // The atlas font size keys the cache: a rasterization tier switch
    // changes every measured advance.
    const key = `${this.#atlas.fontPx}\u0000${maxWidth}\u0000${maxLines}\u0000${label}`;
    let fitted = this.#labelCache.get(key);
    if (fitted === undefined) {
      fitted = wrapEllipsized(this.#atlas, label, maxWidth, maxLines);
      if (this.#labelCache.size > 4096) this.#labelCache.clear();
      this.#labelCache.set(key, fitted);
    }
    return fitted;
  }

  #initAtlasTexture(): void {
    const gl = this.#gl;
    gl.bindTexture(gl.TEXTURE_2D, this.#atlasTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.#atlasVersion = -1;
  }

  #uploadAtlas(): void {
    const gl = this.#gl;
    gl.bindTexture(gl.TEXTURE_2D, this.#atlasTexture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.#atlas.canvas);
    this.#atlasVersion = this.#atlas.version;
  }

  /** One VAO per program: a static quad at location 0 plus instance fields
   * starting at location 1, packed contiguously in one instance buffer that
   * frames re-upload through the returned handle. */
  #makeVao(
    quad: Float32Array,
    capacityFloats: number,
    fields: Array<[size: number, offset: number]>,
  ): { vao: WebGLVertexArrayObject; buffer: WebGLBuffer } {
    const gl = this.#gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const quadBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);

    const instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, capacityFloats * 4, gl.DYNAMIC_DRAW);
    // Per-instance stride from the packed field layout — NOT the buffer
    // capacity: a capacity-sized stride walks every instance out of bounds
    // and the draw call gets discarded outright.
    const stride = Math.max(...fields.map(([size, offset]) => (offset + size) * 4));
    fields.forEach(([size, offset], index) => {
      const location = index + 1;
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset * 4);
      gl.vertexAttribDivisor(location, 1);
    });
    gl.bindVertexArray(null);
    return { vao, buffer: instanceBuffer };
  }
}
