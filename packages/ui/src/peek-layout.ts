/**
 * Peek card layout geometry (ui DESIGN.md, "交互"): pure math turning the
 * three inputs the card may consult — page (viewport) size, cursor position
 * and the card's own size — into a placement. The invariants that always
 * hold (the component caps the card with `max-width`/`max-height`, so the
 * card size always fits them):
 *
 * - the card never leaves the viewport (at least `PEEK_PAD` from every edge);
 * - horizontally the card never covers the cursor (at least `PEEK_GAP` away);
 * - vertically the cursor stays clear unless the content is taller than
 *   both sides of the cursor afford — width grows first and the height may
 *   use the whole page, so only then does the content scroll in-card.
 */

/** Minimum distance between the card and any viewport edge. */
export const PEEK_PAD = 8;
/** Minimum distance between the card and the cursor point. */
export const PEEK_GAP = 16;
/** Narrowest card width; content may grow it up to the page-afforded max. */
export const PEEK_MIN_WIDTH = 280;
/** First-frame size estimate, replaced by the card's measured size. */
export const PEEK_ESTIMATED_SIZE = { width: PEEK_MIN_WIDTH, height: 320 };

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
 * to the other side when that side cannot afford the card. The maxima depend
 * only on cursor and viewport — never on the card size — so measured sizes
 * cannot feed back and oscillate. Width caps at the roomier side, so
 * horizontally the chosen side always fits and the cursor stays clear.
 * Height caps at the whole page: whenever neither side alone affords the
 * card, it pins to the top edge and may cover the cursor vertically rather
 * than scroll earlier than necessary.
 */
export function computePeekLayout({ viewport, cursor, card }: PeekLayoutInput): PeekLayout {
  const availRight = viewport.width - PEEK_PAD - (cursor.x + PEEK_GAP);
  const availLeft = cursor.x - PEEK_GAP - PEEK_PAD;
  const availBottom = viewport.height - PEEK_PAD - (cursor.y + PEEK_GAP);
  const maxWidth = Math.max(availLeft, availRight, 0);
  const maxHeight = Math.max(viewport.height - 2 * PEEK_PAD, 0);
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
