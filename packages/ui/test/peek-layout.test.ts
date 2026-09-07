import { describe, expect, it } from "vitest";
import { computePeekLayout, PEEK_BASE_WIDTH, PEEK_GAP, PEEK_PAD } from "../src/peek-layout";
import type { PeekLayoutInput } from "../src/peek-layout";

/**
 * Placement invariants (peek-layout.ts): the card stays on the page with at
 * least PEEK_PAD to every edge, and never covers the cursor. The card the
 * component renders is capped at min(base width, maxWidth) by maxHeight, so
 * the invariants are checked against that capped size.
 */

const BASE_VIEWPORT = { width: 1280, height: 800 };
const BASE_CARD = { width: 380, height: 240 };

function placed(input: PeekLayoutInput) {
  const layout = computePeekLayout(input);
  return {
    layout,
    width: Math.min(input.card.width, PEEK_BASE_WIDTH, layout.maxWidth),
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
  const { layout, width, height } = placed(input);
  const coversCursor =
    input.cursor.x > layout.left &&
    input.cursor.x < layout.left + width &&
    input.cursor.y > layout.top &&
    input.cursor.y < layout.top + height;
  expect(coversCursor).toBe(false);
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
    // Maxima follow the roomier side per axis (right, bottom here).
    expect(layout.maxWidth).toBe(BASE_VIEWPORT.width - PEEK_PAD - (200 + PEEK_GAP));
    expect(layout.maxHeight).toBe(BASE_VIEWPORT.height - PEEK_PAD - (150 + PEEK_GAP));
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

  it("shrinks the maxima when the viewport cannot afford the base size", () => {
    const layout = computePeekLayout({
      viewport: { width: 400, height: 300 },
      cursor: { x: 200, y: 150 },
      card: BASE_CARD,
    });
    // The cursor splits the tiny viewport in half; the card shrinks to the
    // half it faces and ends exactly at the page edge.
    expect(layout.maxWidth).toBe(176);
    expect(layout.maxHeight).toBe(126);
    expectInsidePage({
      viewport: { width: 400, height: 300 },
      cursor: { x: 200, y: 150 },
      card: BASE_CARD,
    });
  });

  it("keeps the card on the page and off the cursor across a cursor grid", () => {
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
    expect(layout.maxHeight).toBe(0);
    expect(layout.left).toBeGreaterThanOrEqual(PEEK_PAD);
    expect(layout.top).toBeGreaterThanOrEqual(PEEK_PAD);
    expect(Number.isFinite(layout.left)).toBe(true);
    expect(Number.isFinite(layout.top)).toBe(true);
  });
});
