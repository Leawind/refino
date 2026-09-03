/**
 * Glyph atlas for label rendering: characters are rasterized once into a
 * 2D canvas (shelf packing, one cell per glyph) that the renderer uploads
 * as a texture. White bitmaps only — color comes from the shader. When the
 * atlas runs out of cells it resets wholesale and refills on subsequent
 * frames.
 */

export interface Glyph {
  /** Normalized texture rectangle of the bitmap. */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Bitmap size and baseline offset inside it, in atlas pixels. */
  width: number;
  height: number;
  ascent: number;
  /** Pen advance in atlas pixels (0 for blank glyphs like spaces). */
  advance: number;
}

const ATLAS_SIZE = 2048;
const CELL = 32;
const CELL_PAD = 2;
/** Atlas rasterization font; label quads scale this down to LABEL_FONT_PX. */
export const ATLAS_FONT_PX = 24;
const FONT = `${ATLAS_FONT_PX}px system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;

export class GlyphAtlas {
  readonly canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  #glyphs = new Map<string, Glyph>();
  #nextCell = 0;
  #version = 0;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = ATLAS_SIZE;
    this.canvas.height = ATLAS_SIZE;
    this.#ctx = this.canvas.getContext("2d")!;
    this.#ctx.font = FONT;
    this.#ctx.textBaseline = "alphabetic";
    this.#ctx.fillStyle = "#ffffff";
  }

  /** Bumped on every rasterization; the renderer re-uploads when it changes. */
  get version(): number {
    return this.#version;
  }

  get full(): boolean {
    return this.#nextCell >= (ATLAS_SIZE / CELL) ** 2;
  }

  /** Text advance width in atlas pixels at the atlas font size. */
  measure(text: string): number {
    this.#ctx.font = FONT;
    return this.#ctx.measureText(text).width;
  }

  /** The glyph for `ch`, rasterizing it first; undefined when the atlas is
   * full (the renderer resets it and retries next frame). */
  glyph(ch: string): Glyph | undefined {
    const known = this.#glyphs.get(ch);
    if (known !== undefined) return known;
    if (ch === " ") {
      const blank: Glyph = {
        u0: 0,
        v0: 0,
        u1: 0,
        v1: 0,
        width: 0,
        height: 0,
        ascent: 0,
        advance: this.measure(ch),
      };
      this.#glyphs.set(ch, blank);
      return blank;
    }
    if (this.full) return undefined;

    this.#ctx.font = FONT;
    const metrics = this.#ctx.measureText(ch);
    const width = Math.min(CELL - CELL_PAD * 2, Math.ceil(metrics.width));
    const ascent = Math.min(CELL - CELL_PAD * 2, Math.ceil(metrics.actualBoundingBoxAscent));
    const height = Math.min(
      CELL - CELL_PAD * 2,
      ascent + Math.ceil(metrics.actualBoundingBoxDescent),
    );
    const cellX = (this.#nextCell % (ATLAS_SIZE / CELL)) * CELL;
    const cellY = Math.floor(this.#nextCell / (ATLAS_SIZE / CELL)) * CELL;
    this.#nextCell++;
    this.#ctx.clearRect(cellX, cellY, CELL, CELL);
    this.#ctx.fillText(ch, cellX + CELL_PAD, cellY + CELL_PAD + ascent);
    this.#version++;

    const glyph: Glyph = {
      u0: (cellX + CELL_PAD) / ATLAS_SIZE,
      v0: (cellY + CELL_PAD) / ATLAS_SIZE,
      u1: (cellX + CELL_PAD + width) / ATLAS_SIZE,
      v1: (cellY + CELL_PAD + height) / ATLAS_SIZE,
      width,
      height,
      ascent,
      advance: metrics.width,
    };
    this.#glyphs.set(ch, glyph);
    return glyph;
  }

  /** Drop every rasterized glyph; the renderer re-uploads the cleared texture. */
  reset(): void {
    this.#glyphs.clear();
    this.#nextCell = 0;
    this.#ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
    this.#version++;
  }
}

/** Shorten `text` with an ellipsis so it fits `maxWidth` atlas pixels. */
export function ellipsize(atlas: GlyphAtlas, text: string, maxWidth: number): string {
  if (atlas.measure(text) <= maxWidth) return text;
  for (let end = text.length; end > 0; end--) {
    const candidate = `${text.slice(0, end)}…`;
    if (atlas.measure(candidate) <= maxWidth) return candidate;
  }
  return "…";
}
