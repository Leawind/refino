import { describe, expect, it } from "vitest";
import {
  computePeekBounds,
  computePeekPlacement,
  computePeekSize,
  PEEK_GAP,
  PEEK_MIN_WIDTH,
  PEEK_PAD,
} from "../src/peek-layout";
import type { PeekPlacementInput } from "../src/peek-layout";

/**
 * Sizing invariants (peek-layout.ts): the size depends on the content and
 * the page bounds only — never on the cursor — so smooth cursor movement
 * cannot re-wrap the text; the card prefers a square. Placement keeps the
 * card on the page, gap-clear of the cursor whenever either side affords
 * the card, pinning to the roomier page edge only when neither does.
 */

const BASE_VIEWPORT = { width: 1280, height: 800 };
const BASE_CARD = { width: 380, height: 240 };

describe("computePeekBounds", () => {
  it("is cursor-independent: the page minus the pads", () => {
    expect(computePeekBounds(BASE_VIEWPORT)).toEqual({ maxWidth: 1264, maxHeight: 784 });
  });
});

describe("computePeekPlacement", () => {
  function placed({ viewport, cursor, card }: PeekPlacementInput) {
    return computePeekPlacement({ viewport, cursor, card });
  }

  function expectInsidePage(input: PeekPlacementInput): void {
    const { left, top } = placed(input);
    const width = Math.min(input.card.width, input.viewport.width - 2 * PEEK_PAD);
    const height = Math.min(input.card.height, input.viewport.height - 2 * PEEK_PAD);
    expect(left).toBeGreaterThanOrEqual(PEEK_PAD);
    expect(top).toBeGreaterThanOrEqual(PEEK_PAD);
    expect(left + width).toBeLessThanOrEqual(input.viewport.width - PEEK_PAD);
    expect(top + height).toBeLessThanOrEqual(input.viewport.height - PEEK_PAD);
  }

  function expectCursorClear(input: PeekPlacementInput): void {
    const { left, top } = placed(input);
    const width = Math.min(input.card.width, input.viewport.width - 2 * PEEK_PAD);
    const height = Math.min(input.card.height, input.viewport.height - 2 * PEEK_PAD);
    const availRight = input.viewport.width - PEEK_PAD - (input.cursor.x + PEEK_GAP);
    const availLeft = input.cursor.x - PEEK_GAP - PEEK_PAD;
    if (availRight < width && availLeft < width) return; // pin regime
    expect(input.cursor.x >= left && input.cursor.x <= left + width).toBe(false);
    const availBottom = input.viewport.height - PEEK_PAD - (input.cursor.y + PEEK_GAP);
    const availTop = input.cursor.y - PEEK_GAP - PEEK_PAD;
    if (availBottom < height && availTop < height) return;
    expect(input.cursor.y >= top && input.cursor.y <= top + height).toBe(false);
  }

  it("sits below right of the cursor by default", () => {
    const { left, top } = placed({
      viewport: BASE_VIEWPORT,
      cursor: { x: 200, y: 150 },
      card: BASE_CARD,
    });
    expect(left).toBe(200 + PEEK_GAP);
    expect(top).toBe(150 + PEEK_GAP);
  });

  it("flips to the left near the right edge", () => {
    const { left, top } = placed({
      viewport: BASE_VIEWPORT,
      cursor: { x: 1200, y: 150 },
      card: BASE_CARD,
    });
    expect(left).toBe(1200 - PEEK_GAP - BASE_CARD.width);
    expect(top).toBe(150 + PEEK_GAP);
  });

  it("flips upward near the bottom edge", () => {
    const { left, top } = placed({
      viewport: BASE_VIEWPORT,
      cursor: { x: 200, y: 700 },
      card: BASE_CARD,
    });
    expect(left).toBe(200 + PEEK_GAP);
    expect(top).toBe(700 - PEEK_GAP - BASE_CARD.height);
  });

  it("flips diagonally in the bottom-right corner", () => {
    const { left, top } = placed({
      viewport: BASE_VIEWPORT,
      cursor: { x: 1200, y: 700 },
      card: BASE_CARD,
    });
    expect(left).toBe(1200 - PEEK_GAP - BASE_CARD.width);
    expect(top).toBe(700 - PEEK_GAP - BASE_CARD.height);
  });

  it("pins to the roomier edge when neither side affords the card", () => {
    // Wide card in the middle of a small page: no side fits; the card pins
    // to the right edge instead of shrinking (position clamps, size stays).
    const viewport = { width: 640, height: 480 };
    const { left, top } = placed({
      viewport,
      cursor: { x: 320, y: 240 },
      card: { width: 500, height: 200 },
    });
    expect(left).toBe(viewport.width - PEEK_PAD - 500);
    expect(top).toBe(240 + PEEK_GAP);
    expectInsidePage({ viewport, cursor: { x: 320, y: 240 }, card: { width: 500, height: 200 } });
  });

  it("keeps the card on the page across a cursor grid", () => {
    const viewport = { width: 1024, height: 640 };
    for (const card of [BASE_CARD, { width: 700, height: 500 }]) {
      for (let x = 0; x <= viewport.width; x += 32) {
        for (let y = 0; y <= viewport.height; y += 32) {
          const input: PeekPlacementInput = { viewport, cursor: { x, y }, card };
          expectInsidePage(input);
          expectCursorClear(input);
        }
      }
    }
  });
});

describe("computePeekSize", () => {
  // Wrapping model: the text block has a fixed area, so height(w) = area/w
  // (non-increasing) — good enough to exercise the bisection.
  function reflow(area: number) {
    return (width: number): number => area / width;
  }
  const never = () => 0;

  it("takes the reflowed height as the square side for wide text", () => {
    // GOAL-like CJK text: natural width capped at maxW (1201) while only
    // ~483 tall — narrowing must square it up near sqrt(area).
    const size = computePeekSize({
      natural: { width: 1201, height: 483 },
      maxWidth: 1201,
      measureHeight: reflow(560_000),
    });
    expect(size.width).toBeGreaterThan(700);
    expect(size.width).toBeLessThan(800);
  });

  it("takes the content height as the side when it already passes the width", () => {
    expect(
      computePeekSize({ natural: { width: 380, height: 500 }, maxWidth: 876, measureHeight: never })
        .width,
    ).toBe(500);
  });

  it("caps the side at maxWidth for tall content", () => {
    expect(
      computePeekSize({
        natural: { width: 380, height: 2000 },
        maxWidth: 600,
        measureHeight: never,
      }).width,
    ).toBe(600);
  });

  it("narrows reflowing flat prose to the width floor", () => {
    // A one-line CJK premise: natural width ~779 while only ~106 tall, and
    // still under the floor height at the floor width — the most square
    // flat shape is the narrowest one, not the full natural width ribbon.
    const size = computePeekSize({
      natural: { width: 779, height: 106 },
      maxWidth: 1264,
      measureHeight: reflow(50_000),
    });
    expect(size.width).toBe(PEEK_MIN_WIDTH);
  });

  it("keeps the natural width for flat blocks that cannot reflow", () => {
    // A wide table/code line: narrowing changes no height, so the natural
    // width is real and kept (the card scrolls it horizontally if capped).
    const size = computePeekSize({
      natural: { width: 600, height: 150 },
      maxWidth: 1264,
      measureHeight: () => 150,
    });
    expect(size.width).toBe(600);
  });

  it("narrows reflowing text that stays flat at the floor", () => {
    // Reflowing text that stays flat at the floor width still narrows to it.
    const size = computePeekSize({
      natural: { width: 380, height: 90 },
      maxWidth: 600,
      measureHeight: (w) => (w < 380 ? 120 : 90),
    });
    expect(size.width).toBe(PEEK_MIN_WIDTH);
  });

  it("floors at the minimum width for narrow flat content", () => {
    const size = computePeekSize({
      natural: { width: 150, height: 100 },
      maxWidth: 600,
      measureHeight: () => 100,
    });
    expect(size.width).toBe(PEEK_MIN_WIDTH);
  });

  it("handles a viewport narrower than the width floor", () => {
    expect(
      computePeekSize({
        natural: { width: 100, height: 50 },
        maxWidth: 200,
        measureHeight: () => 50,
      }).width,
    ).toBe(200);
  });

  it("is exact when the content is already square", () => {
    expect(
      computePeekSize({ natural: { width: 400, height: 400 }, maxWidth: 876, measureHeight: never })
        .width,
    ).toBe(400);
  });
});
