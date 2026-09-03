import { ellipsize, GlyphAtlas } from "./atlas";
import {
  COST_SHAPE_NODE,
  COST_TEXT_NODE,
  cullByBudget,
  TEXT_LOD_SCREEN_H,
  type AdaptiveBudget,
  type CullEntry,
} from "./budget";
import { createProgram, EDGE_QUAD, type Program, UNIT_QUAD } from "./shaders";

/**
 * WebGL2 canvas renderer for the working set (ui README, "画布"): batched
 * instanced drawing of nodes, edges and labels, with the render budget
 * culling over-budget nodes and the hover fade-in/out as per the display
 * rules. DOM floating controls stay outside this module.
 *
 * Frames render on damage only (scene/camera/theme changes, resize,
 * running fade animations); the render budget adapts while frames render
 * continuously. The camera only moves when asked — `fitToContent()` from
 * focus changes, direction switches and resizes — so the incremental
 * layout's stable virtual space stays put while the working set expands.
 * Pan/zoom and fly-to-focus belong to the viewport milestone and replace
 * `#refit`.
 */

export type RGBA = [number, number, number, number];

export interface ThemeColors {
  nodeBg: RGBA;
  nodeBorder: RGBA;
  edge: RGBA;
  primary: RGBA;
  text: RGBA;
}

/** A node as submitted by the component, in virtual layout coordinates. */
export interface RenderNodeInput {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Constraints round their corners; premises are square. */
  rounded: boolean;
  label: string;
  selected: boolean;
  focus: boolean;
  hovered: boolean;
  /** Render priority class (CULL_*), decided by the component. */
  cls: number;
  /** Distance to the nearest selected node, ordering within a class. */
  distance: number;
  /** Fade in instead of appearing at once (hover-pulled premises). */
  fadeIn?: boolean;
}

export interface RenderEdgeInput {
  fromId: string;
  toId: string;
  emphasized: boolean;
}

export interface SceneInput {
  nodes: RenderNodeInput[];
  edges: RenderEdgeInput[];
}

export interface RenderInfo {
  /** The last frame dropped nodes or edges to fit the render budget. */
  culled: boolean;
}

const FIT_MAX_SCALE = 1;
const FIT_MARGIN = 24;
const LABEL_FONT_PX = 12;
const LABEL_PAD_X = 10;
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

/** Reads the canvas palette from the theme tokens on <html>. */
export function readThemeColors(): ThemeColors {
  const root = getComputedStyle(document.documentElement);
  const body = getComputedStyle(document.body);
  const token = (name: string, fallback: string): RGBA =>
    parseColor(root.getPropertyValue(name) || fallback);
  return {
    nodeBg: token("--refino-node-bg", "rgba(128, 128, 128, 0.08)"),
    nodeBorder: token("--refino-node-border", "rgba(128, 128, 128, 0.4)"),
    edge: token("--refino-edge", "rgba(128, 128, 128, 0.5)"),
    primary: token("--refino-primary", "#18a058"),
    text: parseColor(body.color || "rgba(0, 0, 0, 0.9)"),
  };
}

interface Entry {
  node: RenderNodeInput;
  alpha: number;
  target: number;
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
  #atlasTexture: WebGLTexture;
  #atlasVersion = -1;

  #entries = new Map<string, Entry>();
  #edges: RenderEdgeInput[] = [];
  #admitted = new Set<string>();
  #culled = false;
  #labelCache = new Map<string, string>();

  #theme: ThemeColors = {
    nodeBg: [0.5, 0.5, 0.5, 0.08],
    nodeBorder: [0.5, 0.5, 0.5, 0.4],
    edge: [0.5, 0.5, 0.5, 0.5],
    primary: [0.09, 0.63, 0.35, 1],
    text: [0.1, 0.1, 0.1, 0.9],
  };
  #camera = { scale: 1, tx: 0, ty: 0 };
  #cssWidth = 0;
  #cssHeight = 0;
  #fitDirty = true;

  #edgeProgram: Program;
  #nodeProgram: Program;
  #textProgram: Program;
  #edgeVao: WebGLVertexArrayObject;
  #nodeVao: WebGLVertexArrayObject;
  #textVao: WebGLVertexArrayObject;
  #edgeInstances: WebGLBuffer;
  #nodeInstances: WebGLBuffer;
  #textInstances: WebGLBuffer;
  #edgeData = new Float32Array(9 * 64);
  #nodeData = new Float32Array(16 * 64);
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

  static create(canvas: HTMLCanvasElement, budget: AdaptiveBudget): GraphRenderer | null {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      // The frame is damage-driven; keeping the buffer means hosts can
      // snapshot the canvas outside the drawing frame.
      preserveDrawingBuffer: true,
    });
    return gl === null ? null : new GraphRenderer(canvas, gl, budget);
  }

  private constructor(
    canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
    budget: AdaptiveBudget,
  ) {
    this.#canvas = canvas;
    this.#gl = gl;
    this.#budget = budget;

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
      [2, 14],
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

    canvas.addEventListener("webglcontextlost", this.#onContextLost);
    canvas.addEventListener("webglcontextrestored", this.#onContextRestored);
    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(canvas);
    this.#resize();
  }

  /** Replaces the whole display list; takes effect on the next frame. */
  setScene(scene: SceneInput): void {
    const seen = new Set<string>();
    for (const node of scene.nodes) {
      seen.add(node.id);
      const entry = this.#entries.get(node.id);
      if (entry !== undefined) {
        entry.node = node;
        entry.target = 1;
      } else {
        // Hover-pulled premises fade in; everything else appears at once so
        // the first frame is complete even under rAF throttling. The
        // fade-out reuses the last known geometry.
        this.#entries.set(node.id, {
          node,
          alpha: node.fadeIn ? 0 : 1,
          target: 1,
        });
      }
    }
    for (const entry of this.#entries.values()) {
      if (!seen.has(entry.node.id)) entry.target = 0;
    }
    this.#edges = scene.edges;
    this.#schedule();
  }

  /** Moves the camera to fit the working-set bounding box on the next
   * frame; called when the focus changes or the direction flips, never per
   * working-set expansion (that would defeat the stable layout). */
  fitToContent(): void {
    this.#fitDirty = true;
    this.#schedule();
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
    this.#canvas.removeEventListener("webglcontextlost", this.#onContextLost);
    this.#canvas.removeEventListener("webglcontextrestored", this.#onContextRestored);
    this.#gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  #onContextLost = (event: Event): void => {
    event.preventDefault();
    this.#lost = true;
  };

  #onContextRestored = (): void => {
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
    this.#budget.reestimate({ width, height });
    this.#fitDirty = true;
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

    const animating = this.#tweenAlphas(now);
    if (this.#fitDirty) this.#refit();
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

  /** Fits the camera to the working-set bounding box (viewport milestone
   * replaces this with a stable virtual space). */
  #refit(): void {
    this.#fitDirty = false;
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
    if (!Number.isFinite(minX)) return;
    const scale = Math.min(
      FIT_MAX_SCALE,
      (this.#cssWidth - FIT_MARGIN * 2) / (maxX - minX),
      (this.#cssHeight - FIT_MARGIN * 2) / (maxY - minY),
    );
    const fitScale = Math.max(0.05, scale);
    this.#camera = {
      scale: fitScale,
      tx: (this.#cssWidth - (maxX - minX) * fitScale) / 2 - minX * fitScale,
      ty: (this.#cssHeight - (maxY - minY) * fitScale) / 2 - minY * fitScale,
    };
  }

  #cullAndDraw(): void {
    const gl = this.#gl;
    const budget = this.#budget.current();
    const scale = this.#camera.scale;
    const lowLod = 44 * scale < TEXT_LOD_SCREEN_H;

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
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.#drawEdges(lowLod, result.edges);
    this.#drawNodes();
    this.#drawText(textShown);

    this.#frameEnd?.({ culled: this.#culled });
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
      const width = edge.emphasized ? EDGE_WIDTH_EMPHASIZED : lowLod ? EDGE_WIDTH_LOD : EDGE_WIDTH;
      const color = edge.emphasized ? this.#theme.primary : this.#theme.edge;
      const base = count * 9;
      // Virtual layout coordinates go through the camera; the shader only
      // knows CSS pixels.
      this.#edgeData[base] = (from.node.x + from.node.width / 2) * scale + tx;
      this.#edgeData[base + 1] = (from.node.y + from.node.height / 2) * scale + ty;
      this.#edgeData[base + 2] = (to.node.x + to.node.width / 2) * scale + tx;
      this.#edgeData[base + 3] = (to.node.y + to.node.height / 2) * scale + ty;
      this.#edgeData[base + 4] = width;
      this.#edgeData.set(color, base + 5);
      count++;
    }

    const { program, uniform } = this.#edgeProgram;
    gl.useProgram(program);
    gl.uniform2f(uniform("u_resolution"), this.#canvas.width, this.#canvas.height);
    gl.uniform1f(uniform("u_dpr"), window.devicePixelRatio || 1);
    gl.bindVertexArray(this.#edgeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#edgeInstances);
    gl.bufferData(gl.ARRAY_BUFFER, this.#edgeData.slice(0, count * 9), gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    gl.bindVertexArray(null);
  }

  #drawNodes(): void {
    const gl = this.#gl;
    const scale = this.#camera.scale;
    const tx = this.#camera.tx;
    const ty = this.#camera.ty;
    let count = 0;
    for (const [id, entry] of this.#entries) {
      if (entry.alpha < 0.01 || !this.#admitted.has(id)) continue;
      if ((count + 1) * 16 > this.#nodeData.length) this.#nodeData = grow(this.#nodeData);
      const node = entry.node;
      const borderWidth = node.focus
        ? BORDER_WIDTH_FOCUS
        : node.selected
          ? BORDER_WIDTH_SELECTED
          : node.hovered
            ? BORDER_WIDTH_HOVERED
            : BORDER_WIDTH;
      const borderColor =
        node.selected || node.focus || node.hovered ? this.#theme.primary : this.#theme.nodeBorder;
      const base = count * 16;
      this.#nodeData[base] = (node.x + node.width / 2) * scale + tx;
      this.#nodeData[base + 1] = (node.y + node.height / 2) * scale + ty;
      this.#nodeData[base + 2] = node.width * scale;
      this.#nodeData[base + 3] = node.height * scale;
      this.#nodeData[base + 4] = node.rounded ? CORNER_RADIUS : 0;
      this.#nodeData[base + 5] = borderWidth;
      this.#nodeData.set(this.#theme.nodeBg, base + 6);
      this.#nodeData.set(borderColor, base + 10);
      this.#nodeData[base + 14] = node.selected ? 1 : 0;
      this.#nodeData[base + 15] = entry.alpha;
      count++;
    }

    const { program, uniform } = this.#nodeProgram;
    gl.useProgram(program);
    gl.uniform2f(uniform("u_resolution"), this.#canvas.width, this.#canvas.height);
    gl.uniform1f(uniform("u_dpr"), window.devicePixelRatio || 1);
    gl.uniform4fv(uniform("u_primary"), this.#theme.primary);
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
    const fontScale = LABEL_FONT_PX / 24; // atlas font pixels → label pixels
    let count = 0;
    for (const [id, entry] of this.#entries) {
      if (entry.alpha < 0.02 || !this.#admitted.has(id) || !textShown.get(id)) continue;
      const node = entry.node;
      const maxWidth = (node.width * scale - LABEL_PAD_X * 2) / fontScale;
      const label = this.#labelFor(node.label, maxWidth);
      let penX = node.x * scale + this.#camera.tx + LABEL_PAD_X;
      const baseline =
        node.y * scale + this.#camera.ty + (node.height * scale) / 2 + LABEL_FONT_PX * 0.35;
      for (const ch of label) {
        const glyph = this.#atlas.glyph(ch);
        if (glyph === undefined) break; // atlas ran full; retries next frame
        if ((count + 1) * 9 > this.#textData.length) this.#textData = grow(this.#textData);
        if (glyph.width > 0) {
          const base = count * 9;
          this.#textData[base] = penX;
          this.#textData[base + 1] = baseline - glyph.ascent * fontScale;
          this.#textData[base + 2] = glyph.width * fontScale;
          this.#textData[base + 3] = glyph.height * fontScale;
          this.#textData[base + 4] = glyph.u0;
          this.#textData[base + 5] = glyph.v0;
          this.#textData[base + 6] = glyph.u1 - glyph.u0;
          this.#textData[base + 7] = glyph.v1 - glyph.v0;
          this.#textData[base + 8] = entry.alpha;
          count++;
        }
        penX += glyph.advance * fontScale;
      }
    }

    // Rasterization above may have grown the atlas; one upload covers it all.
    if (this.#atlas.version !== this.#atlasVersion) this.#uploadAtlas();
    const { program, uniform } = this.#textProgram;
    gl.useProgram(program);
    gl.uniform2f(uniform("u_resolution"), this.#canvas.width, this.#canvas.height);
    gl.uniform1f(uniform("u_dpr"), window.devicePixelRatio || 1);
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

  #labelFor(label: string, maxWidth: number): string {
    const key = `${maxWidth}\u0000${label}`;
    let fitted = this.#labelCache.get(key);
    if (fitted === undefined) {
      fitted = ellipsize(this.#atlas, label, maxWidth);
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
