/**
 * Peek card layout geometry (ui DESIGN.md, "交互"): pure math turning the
 * three inputs the card may consult — page (viewport) size, cursor position
 * and the card's own size — into a placement. Two invariants hold whenever
 * the card size fits its returned maxima (the component caps the card with
 * `max-width`/`max-height`, so they always do):
 *
 * - the card never leaves the viewport (at least `PEEK_PAD` from every edge);
 * - the card never covers the cursor (at least `PEEK_GAP` away from it).
 *
 * Content that still does not fit scrolls inside the card.
 */

/** Minimum distance between the card and any viewport edge. */
export const PEEK_PAD = 8;
/** Minimum distance between the card and the cursor point. */
export const PEEK_GAP = 16;
/** Preferred card width; shrinks only when the viewport cannot afford it. */
export const PEEK_BASE_WIDTH = 380;
/** First-frame size estimate, replaced by the card's measured size. */
export const PEEK_ESTIMATED_SIZE = { width: PEEK_BASE_WIDTH, height: 320 };

export interface PeekLayoutInput {
  /** Page (viewport) size in CSS pixels. */
  viewport: { width: number; height: number };
  /** Cursor position in viewport coordinates. */
  cursor: { x: number; y: number };
  /** Card size — measured when available, estimated on the first frame. */
  card: { width: number; height: number };
}

export interface PeekLayout {
  left: number;
  top: number;
  maxWidth: number;
  maxHeight: number;
}

/**
 * Place the card at the cursor's lower right by default, flipping each axis
 * to the other side when that side cannot afford the card. The maxima use
 * the roomier side along each axis and depend only on cursor and viewport —
 * never on the card size — so measured sizes cannot feed back and oscillate.
 * Because the card is capped at the maximum, the chosen side always fits:
 * whenever the default side does not, the other side is strictly larger.
 */
export function computePeekLayout({ viewport, cursor, card }: PeekLayoutInput): PeekLayout {
  const availRight = viewport.width - PEEK_PAD - (cursor.x + PEEK_GAP);
  const availLeft = cursor.x - PEEK_GAP - PEEK_PAD;
  const availBottom = viewport.height - PEEK_PAD - (cursor.y + PEEK_GAP);
  const availTop = cursor.y - PEEK_GAP - PEEK_PAD;
  const maxWidth = Math.max(availLeft, availRight, 0);
  const maxHeight = Math.max(availTop, availBottom, 0);
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
