import { describe, expect, it } from "vitest";
import { computePeekLayout, PEEK_GAP, PEEK_MIN_WIDTH, PEEK_PAD } from "../src/peek-layout";
import type { PeekLayoutInput } from "../src/peek-layout";

/**
 * Placement invariants (peek-layout.ts): the card stays on the page with at
 * least PEEK_PAD to every edge, and the cursor stays horizontally clear of
 * the card. Vertically the cursor may be covered when the content is taller
 * than both sides of the cursor afford — the height may then use the whole
 * page instead of scrolling earlier. The card the component renders is
 * capped at maxWidth/maxHeight (width starts at fit-content with a
 * PEEK_MIN_WIDTH floor), so the invariants are checked against the capped
 * size.
 */

const BASE_VIEWPORT = { width: 1280, height: 800 };
const BASE_CARD = { width: 380, height: 240 };

function placed(input: PeekLayoutInput) {
  const layout = computePeekLayout(input);
  return {
    layout,
    width: Math.min(input.card.width, layout.maxWidth),
    height: Math.min(input.card.height, layout.maxHeight),
  };
}

function expectInsidePage(input: PeekLayoutInput): void {
  const { layout, width, height } = placed(input);
  expect(layout.left).toBeGreaterThanOrEqual(PEEK_PAD);
  expect(layout.top).toBeGreaterThanOrEqual(PEEK_PAD);
  expect(layout.left + width).toBeLessThanOrEqual(input.viewport.width - PEEK_PAD);
  expect(layout.top + height).toBeLessThanOrEqual(input.viewport.height - PEEK_PAD);
}

function expectClearOfCursor(input: PeekLayoutInput): void {
  const { layout, width } = placed(input);
  // Width grows first up to the roomier side, so the cursor stays clear of
  // the card horizontally no matter how tall the content is.
  const coversCursorX = input.cursor.x > layout.left && input.cursor.x < layout.left + width;
  expect(coversCursorX).toBe(false);
}

describe("computePeekLayout", () => {
  it("places the card at the cursor's lower right by default", () => {
    const layout = computePeekLayout({
      viewport: BASE_VIEWPORT,
      cursor: { x: 200, y: 150 },
      card: BASE_CARD,
    });
    expect(layout.left).toBe(200 + PEEK_GAP);
    expect(layout.top).toBe(150 + PEEK_GAP);
    expect(layout.maxWidth).toBe(BASE_VIEWPORT.width - PEEK_PAD - (200 + PEEK_GAP));
  });

  it("caps the height at the whole page so the card may fill it", () => {
    const layout = computePeekLayout({
      viewport: BASE_VIEWPORT,
      cursor: { x: 640, y: 400 },
      card: BASE_CARD,
    });
    expect(layout.maxHeight).toBe(BASE_VIEWPORT.height - 2 * PEEK_PAD);
  });

  it("flips to the left near the right edge", () => {
    const layout = computePeekLayout({
      viewport: BASE_VIEWPORT,
      cursor: { x: 1200, y: 150 },
      card: BASE_CARD,
    });
    expect(layout.left).toBe(1200 - PEEK_GAP - BASE_CARD.width);
    expect(layout.top).toBe(150 + PEEK_GAP);
  });

  it("flips upward near the bottom edge", () => {
    const layout = computePeekLayout({
      viewport: BASE_VIEWPORT,
      cursor: { x: 200, y: 700 },
      card: BASE_CARD,
    });
    expect(layout.left).toBe(200 + PEEK_GAP);
    expect(layout.top).toBe(700 - PEEK_GAP - BASE_CARD.height);
  });

  it("flips diagonally in the bottom-right corner", () => {
    const layout = computePeekLayout({
      viewport: BASE_VIEWPORT,
      cursor: { x: 1200, y: 700 },
      card: BASE_CARD,
    });
    expect(layout.left).toBe(1200 - PEEK_GAP - BASE_CARD.width);
    expect(layout.top).toBe(700 - PEEK_GAP - BASE_CARD.height);
  });

  it("shrinks the width when the viewport cannot afford the base size", () => {
    const layout = computePeekLayout({
      viewport: { width: 400, height: 300 },
      cursor: { x: 200, y: 150 },
      card: BASE_CARD,
    });
    // The cursor splits the tiny viewport in half; the card shrinks to the
    // half it faces and ends exactly at the page edge.
    expect(layout.maxWidth).toBe(176);
    expectInsidePage({
      viewport: { width: 400, height: 300 },
      cursor: { x: 200, y: 150 },
      card: BASE_CARD,
    });
  });

  it("grows wide before growing tall for short, wide viewports", () => {
    // Cursor near the top: the roomier side is the right one, and a tall
    // content block rides on width first — the height stays page-capped.
    const layout = computePeekLayout({
      viewport: { width: 1600, height: 600 },
      cursor: { x: 300, y: 80 },
      card: { width: 900, height: 500 },
    });
    expect(layout.maxWidth).toBe(1600 - PEEK_PAD - (300 + PEEK_GAP));
    expect(layout.maxHeight).toBe(600 - 2 * PEEK_PAD);
    expectInsidePage({
      viewport: { width: 1600, height: 600 },
      cursor: { x: 300, y: 80 },
      card: { width: 900, height: 500 },
    });
  });

  it("keeps the card on the page and the cursor clear across a cursor grid", () => {
    const viewport = { width: 1024, height: 640 };
    for (const card of [BASE_CARD, { width: 700, height: 500 }]) {
      for (let x = 0; x <= viewport.width; x += 32) {
        for (let y = 0; y <= viewport.height; y += 32) {
          const input: PeekLayoutInput = { viewport, cursor: { x, y }, card };
          expectInsidePage(input);
          expectClearOfCursor(input);
        }
      }
    }
  });

  it("stays finite and inside on a degenerate viewport", () => {
    const layout = computePeekLayout({
      viewport: { width: 40, height: 30 },
      cursor: { x: 20, y: 15 },
      card: BASE_CARD,
    });
    expect(layout.maxWidth).toBe(0);
    expect(layout.maxHeight).toBe(30 - 2 * PEEK_PAD);
    expect(layout.left).toBeGreaterThanOrEqual(PEEK_PAD);
    expect(layout.top).toBeGreaterThanOrEqual(PEEK_PAD);
    expect(Number.isFinite(layout.left)).toBe(true);
    expect(Number.isFinite(layout.top)).toBe(true);
  });

  it("exposes the minimum width floor to the component", () => {
    expect(PEEK_MIN_WIDTH).toBeGreaterThan(0);
  });
});
