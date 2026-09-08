/**
 * Peek card layout geometry (ui DESIGN.md, "交互"): pure math turning the
 * three inputs the card may consult — page (viewport) size, cursor position
 * and the card's own size — into a shape and a placement. The invariants
 * that always hold (the component caps the card with the returned bounds,
 * so the card size always fits them):
 *
 * - the card never leaves the viewport (at least `PEEK_PAD` from every edge);
 * - horizontally the card never covers the cursor (at least `PEEK_GAP` away);
 * - vertically the cursor stays clear unless the content is taller than the
 *   page affords — the card prefers a square sized to its content and only
 *   extends an axis to a page limit (rectangle) before the content scrolls
 *   in-card.
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

export interface PeekBounds {
  /** Widest the card may be: the roomier horizontal side of the cursor. */
  maxWidth: number;
  /** Tallest the card may be: the whole page between the pads. */
  maxHeight: number;
}

export interface PeekLayoutInput {
  viewport: PeekViewport;
  cursor: PeekCursor;
  /** Card size — measured when available, estimated on the first frame. */
  card: { width: number; height: number };
}

export interface PeekLayout {
  left: number;
  top: number;
  maxWidth: number;
  maxHeight: number;
}

/** Room the page affords the card around the cursor, per axis. */
export function computePeekBounds(viewport: PeekViewport, cursor: PeekCursor): PeekBounds {
  const availRight = viewport.width - PEEK_PAD - (cursor.x + PEEK_GAP);
  const availLeft = cursor.x - PEEK_GAP - PEEK_PAD;
  return {
    maxWidth: Math.max(availLeft, availRight, 0),
    maxHeight: Math.max(viewport.height - 2 * PEEK_PAD, 0),
  };
}

/**
 * Card width from the content's natural size: the card prefers a square.
 * Content at least as tall as its (page-capped) natural width takes that
 * height as the square side; flatter content narrows below the natural
 * width only while narrowing actually makes it taller (prose reflows), so
 * the width becomes the root of height(w) = w — found by bisecting through
 * `measureHeight` — and content too flat to ever square up keeps its
 * natural width. The height then follows the content up to `maxHeight` in
 * CSS, extending the square into a rectangle at a page limit; whatever
 * still overflows scrolls in-card.
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
  if (measureHeight(minWidth) <= minWidth) {
    return { width: clamp(naturalWidth, minWidth, maxWidth) };
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

/**
 * Place the card at the cursor's lower right by default, flipping each axis
 * to the other side when that side cannot afford the card. The placement
 * depends only on cursor and viewport inputs — never on the card size —
 * so measured sizes cannot feed back and oscillate. Because the card is
 * capped at the bounds, the chosen side always fits: whenever the default
 * side does not, the other side is strictly larger. Vertically the card may
 * pin to the top edge and cover the cursor when the content needs the whole
 * page; horizontally the cursor always stays clear.
 */
export function computePeekLayout({ viewport, cursor, card }: PeekLayoutInput): PeekLayout {
  const { maxWidth, maxHeight } = computePeekBounds(viewport, cursor);
  const availRight = viewport.width - PEEK_PAD - (cursor.x + PEEK_GAP);
  const availBottom = viewport.height - PEEK_PAD - (cursor.y + PEEK_GAP);
  const width = Math.min(card.width, maxWidth);
  const height = Math.min(card.height, maxHeight);
  return {
    // Defensive clamp: with the cap applied the flips already stay inside,
    // but the first frame runs on estimated sizes and may exceed the cap.
    left: clamp(
      availRight >= width ? cursor.x + PEEK_GAP : cursor.x - PEEK_GAP - width,
      PEEK_PAD,
      Math.max(PEEK_PAD, viewport.width - PEEK_PAD - width),
    ),
    top: clamp(
      availBottom >= height ? cursor.y + PEEK_GAP : cursor.y - PEEK_GAP - height,
      PEEK_PAD,
      Math.max(PEEK_PAD, viewport.height - PEEK_PAD - height),
    ),
    maxWidth,
    maxHeight,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
