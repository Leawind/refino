/**
 * Glyph atlas for label rendering: characters are rasterized once into a
 * 2D canvas (shelf packing, one cell per glyph) that the renderer uploads
 * as a texture. White bitmaps only — color comes from the shader. When the
 * atlas runs out of cells it resets wholesale and refills on subsequent
 * frames.
 *
 * The rasterization font size follows the on-screen zoom in quantized tiers
 * (quantizeRasterScale): glyphs are re-rasterized at roughly the size they
 * appear on screen, so magnifying the viewport keeps label edges sharp
 * instead of smearing a fixed-size bitmap. A tier switch invalidates the
 * whole atlas; at large zooms the budget cull keeps the visible character
 * set small, so the refill stays well within the atlas capacity.
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
const BASE_FONT_PX = 24;
/** Gap between a cell's glyph and its neighbors. */
const CELL_PAD = 3;
/**
 * Cell size for a rasterization font size: the font's ink box can reach
 * ~1.2em (CJK with full ascent+descent), so the cell gives the glyph ~1.4em
 * plus padding — a tight cell lets ink bleed across the border into the
 * neighboring cell, and the neighbor's quad samples it as a stray block.
 */
function cellFor(fontPx: number): number {
  return Math.round(fontPx * 1.4) + CELL_PAD * 2;
}
/** Atlas rasterization font at tier 1; label quads scale this down to
 * LABEL_FONT_PX. */
export const ATLAS_FONT_PX = BASE_FONT_PX;
/** Rasterization tiers, each ~1.5× the previous: any on-screen zoom lands
 * within ~1.22× of its tier's bitmap, the most LINEAR sampling smears. */
const RASTER_TIERS = [1, 1.5, 2.25, 3.375, 5] as const;

/** The rasterization tier for an on-screen zoom factor: the first tier
 * whose bitmap needs no more than ~1.22× magnification, or the last one. */
export function quantizeRasterScale(zoom: number): number {
  for (const tier of RASTER_TIERS) {
    if (zoom <= tier * 1.22) return tier;
  }
  return RASTER_TIERS[RASTER_TIERS.length - 1] ?? 1;
}

const FONT_FAMILY = `system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;

export class GlyphAtlas {
  readonly canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  #glyphs = new Map<string, Glyph>();
  #nextCell = 0;
  #version = 0;
  /** Current rasterization tier; 1 keeps the original 24px bitmaps. */
  #tier = 1;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = ATLAS_SIZE;
    this.canvas.height = ATLAS_SIZE;
    this.#ctx = this.canvas.getContext("2d")!;
    this.#ctx.textBaseline = "alphabetic";
    this.#ctx.fillStyle = "#ffffff";
    this.#applyFont();
  }

  /** Rasterization font size in atlas pixels at the current tier. */
  get fontPx(): number {
    return BASE_FONT_PX * this.#tier;
  }

  get cell(): number {
    return cellFor(this.fontPx);
  }

  #applyFont(): void {
    this.#ctx.font = `${this.fontPx}px ${FONT_FAMILY}`;
  }

  /** Switches the rasterization tier when it changed; the atlas resets so
   * the next frame refills every glyph at the new size. */
  setRasterScale(tier: number): void {
    if (tier === this.#tier) return;
    this.#tier = tier;
    this.reset();
  }

  /** Bumped on every rasterization; the renderer re-uploads when it changes. */
  get version(): number {
    return this.#version;
  }

  get full(): boolean {
    return this.#nextCell >= this.#cellsPerRow() ** 2;
  }

  /** Whole cells across the atlas: non-divisible tier cells (48, 72, 108,
   * 160 against 2048) must not wrap past the right edge into the next row,
   * which would overlap neighboring glyphs and corrupt sampling. */
  #cellsPerRow(): number {
    return Math.floor(ATLAS_SIZE / this.cell);
  }

  /** Text advance width in atlas pixels at the rasterization font size. */
  measure(text: string): number {
    this.#applyFont();
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

    this.#applyFont();
    const cell = this.cell;
    const metrics = this.#ctx.measureText(ch);
    const width = Math.min(cell - CELL_PAD * 2, Math.ceil(metrics.width));
    const ascent = Math.min(cell - CELL_PAD * 2, Math.ceil(metrics.actualBoundingBoxAscent));
    const height = Math.min(
      cell - CELL_PAD * 2,
      ascent + Math.ceil(metrics.actualBoundingBoxDescent),
    );
    const perRow = this.#cellsPerRow();
    const cellX = (this.#nextCell % perRow) * cell;
    const cellY = Math.floor(this.#nextCell / perRow) * cell;
    this.#nextCell++;
    this.#ctx.clearRect(cellX, cellY, cell, cell);
    this.#ctx.fillText(ch, cellX + CELL_PAD, cellY + CELL_PAD + ascent);
    this.#version++;

    // Inset the sample rect by half a texel: LINEAR filtering at a cell's
    // exact border would blend the neighbor cell's texels into the glyph.
    const inset = 0.5 / ATLAS_SIZE;
    const glyph: Glyph = {
      u0: (cellX + CELL_PAD) / ATLAS_SIZE + inset,
      v0: (cellY + CELL_PAD) / ATLAS_SIZE + inset,
      u1: (cellX + CELL_PAD + width) / ATLAS_SIZE - inset,
      v1: (cellY + CELL_PAD + height) / ATLAS_SIZE - inset,
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

/** Scripts that allow a line break after every character (CJK ideographs,
 * kana, hangul, fullwidth forms and CJK punctuation). */
const CJK_BREAK_AFTER = /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/;

/** Line-wraps `text` into lines that each fit `maxWidth` atlas pixels:
 * greedy fill, preferring the last break opportunity inside a line (after
 * whitespace — kept on the line, so the lines join back to the full text —
 * or after a CJK character); a run with no break opportunity is
 * hard-broken, and an oversized single character still occupies a line. */
export function wrap(atlas: GlyphAtlas, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let start = 0;
  while (start < text.length) {
    // Longest run from `start` that fits the line, but never empty.
    let end = start + 1;
    while (end < text.length && atlas.measure(text.slice(start, end + 1)) <= maxWidth) end++;
    if (end === text.length) {
      lines.push(text.slice(start));
      break;
    }
    let cut = -1;
    for (let i = start; i < end; i++) {
      const ch = text[i]!;
      if (ch === " " || CJK_BREAK_AFTER.test(ch)) cut = i;
    }
    if (cut >= start) {
      lines.push(text.slice(start, cut + 1));
      start = cut + 1;
    } else {
      lines.push(text.slice(start, end));
      start = end;
    }
  }
  return lines.length > 0 ? lines : [text];
}

/** Wraps `text` to at most `maxLines` lines: only when the wrapped text
 * still exceeds the line budget is the overflow collapsed into the last
 * line, which the ellipsis then shortens until it fits. */
export function wrapEllipsized(
  atlas: GlyphAtlas,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const budget = Math.max(1, maxLines);
  const lines = wrap(atlas, text, maxWidth);
  if (lines.length <= budget) return lines;
  const kept = lines.slice(0, budget);
  kept[budget - 1] = ellipsize(atlas, lines.slice(budget - 1).join(""), maxWidth);
  return kept;
}
