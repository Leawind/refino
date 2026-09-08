/**
 * Peek card layout geometry (ui DESIGN.md, "交互"): pure math turning the
 * three inputs the card may consult — page (viewport) size, cursor position
 * and the content's measured size — into a size and a placement. Sizing is
 * deliberately cursor-independent (page bounds only), so smoothly moving
 * the cursor never re-wraps the card's text; the placement absorbs the
 * cursor instead. The invariants that always hold:
 *
 * - the card never leaves the viewport (at least `PEEK_PAD` from every edge);
 * - the card keeps `PEEK_GAP` from the cursor and never covers it whenever
 *   either side of the cursor affords the card; only when neither side does
 *   (a square on a small page) is it pinned to the roomier page edge, where
 *   covering the cursor is unavoidable — the card is non-interactive;
 * - vertically the cursor stays clear unless the content is taller than
 *   the page affords — the card prefers a square sized to its content and
 *   only extends an axis to a page limit (rectangle) before the content
 *   scrolls in-card.
 */

/** Minimum distance between the card and any viewport edge. */
export const PEEK_PAD = 8;
/** Minimum distance between the card and the cursor point. */
export const PEEK_GAP = 16;
/** Narrowest card width; content may grow it up to the page-afforded max. */
export const PEEK_MIN_WIDTH = 280;
/** First-frame size estimate, replaced by the card's measured size. */
export const PEEK_ESTIMATED_SIZE = { width: PEEK_MIN_WIDTH, height: 320 };

export interface PeekViewport {
  /** Page (viewport) size in CSS pixels. */
  width: number;
  height: number;
}

export interface PeekCursor {
  /** Cursor position in viewport coordinates. */
  x: number;
  y: number;
}

/** The card size bounds the page affords, independent of the cursor. */
export interface PeekBounds {
  maxWidth: number;
  maxHeight: number;
}

/** Page-afforded card bounds; the only size inputs besides the content. */
export function computePeekBounds(viewport: PeekViewport): PeekBounds {
  return {
    maxWidth: Math.max(viewport.width - 2 * PEEK_PAD, 0),
    maxHeight: Math.max(viewport.height - 2 * PEEK_PAD, 0),
  };
}

/**
 * Card width from the content's natural size: the card prefers a square.
 * Content at least as tall as its (page-capped) natural width takes that
 * height as the square side; flatter content narrows below the natural
 * width only while narrowing actually makes it taller (prose reflows), so
 * the width becomes the root of height(w) = w — found by bisecting through
 * `measureHeight`; content too flat to ever square up narrows to the width
 * floor when it reflows (prose) and keeps its natural width when narrowing
 * changes nothing (code lines, tables). The height then follows the
 * content up to `maxHeight` in CSS, extending the square into a rectangle
 * at a page limit; whatever still overflows scrolls in-card.
 */
export function computePeekSize({
  natural,
  maxWidth,
  measureHeight,
}: {
  /** Natural content size: max-content width capped at `maxWidth`, and the height at that width. */
  natural: { width: number; height: number };
  maxWidth: number;
  measureHeight: (width: number) => number;
}): { width: number } {
  const minWidth = Math.min(PEEK_MIN_WIDTH, maxWidth);
  const naturalWidth = Math.min(natural.width, maxWidth);
  // Taller than wide at the natural width: the height is the square side,
  // page-capped (a capped side means the rectangle extends heightwise).
  if (natural.height >= naturalWidth) {
    return { width: clamp(natural.height, minWidth, maxWidth) };
  }
  // Flatter than wide: narrowing squares it up only while the content
  // reflows taller; code blocks and tables just stay flat.
  const flatHeight = measureHeight(minWidth);
  if (flatHeight <= minWidth) {
    // Flat content. If narrowing reflows the text taller (prose), take the
    // narrowest width — the most square the flat content allows; blocks
    // that keep their height (code lines, tables) keep the natural width.
    const reflows = flatHeight > natural.height + 1;
    return { width: clamp(reflows ? minWidth : naturalWidth, minWidth, maxWidth) };
  }
  // The square side lies strictly between the bounds: height(w) is
  // non-increasing, so height(w) = w has one root — bisect for it.
  let lo = minWidth;
  let hi = naturalWidth;
  for (let iterations = 0; iterations < 8; iterations++) {
    const mid = (lo + hi) / 2;
    if (measureHeight(mid) > mid) lo = mid;
    else hi = mid;
  }
  return { width: clamp((lo + hi) / 2, minWidth, maxWidth) };
}

export interface PeekPlacementInput {
  viewport: PeekViewport;
  cursor: PeekCursor;
  /** Card size — measured when available, estimated on the first frame. */
  card: { width: number; height: number };
}

/**
 * Place the card at the cursor's lower right by default, flipping each axis
 * to the other side when that side cannot afford the card. When neither
 * side affords it, the card pins to the edge of the roomier side and may
 * cover the cursor rather than shrink (its size is cursor-independent, so
 * moving the pointer never re-wraps the text). The placement depends only
 * on cursor and viewport inputs — never on anything measured — so it
 * cannot feed back into itself.
 */
export function computePeekPlacement({ viewport, cursor, card }: PeekPlacementInput): {
  left: number;
  top: number;
} {
  const width = Math.min(card.width, viewport.width - 2 * PEEK_PAD);
  const height = Math.min(card.height, viewport.height - 2 * PEEK_PAD);
  const availRight = viewport.width - PEEK_PAD - (cursor.x + PEEK_GAP);
  const availLeft = cursor.x - PEEK_GAP - PEEK_PAD;
  const availBottom = viewport.height - PEEK_PAD - (cursor.y + PEEK_GAP);
  const availTop = cursor.y - PEEK_GAP - PEEK_PAD;
  return {
    left:
      availRight >= width
        ? cursor.x + PEEK_GAP
        : availLeft >= width
          ? cursor.x - PEEK_GAP - width
          : availRight >= availLeft
            ? viewport.width - PEEK_PAD - width
            : PEEK_PAD,
    top:
      availBottom >= height
        ? cursor.y + PEEK_GAP
        : availTop >= height
          ? cursor.y - PEEK_GAP - height
          : availBottom >= availTop
            ? viewport.height - PEEK_PAD - height
            : PEEK_PAD,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
