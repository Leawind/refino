import { describe, expect, it } from "vitest";
import {
  calloutHeightCap,
  calloutLeader,
  calloutWidths,
  chooseCalloutPlacement,
  placeSummaryLabels,
  SUMMARY_SCALE_MAX,
  summaryScale,
} from "../src/graph/orbit/callout";
import type { CalloutCandidate, CalloutStar } from "../src/graph/orbit/callout";

/**
 * Callout placement (ui DESIGN.md, "三维视图"): the block must find a hole in
 * the picture, stay beside its star rather than over it, widen where the page
 * allows and narrow where it does not, and hold its spot while that spot is
 * still good.
 */

const VIEWPORT = { width: 1000, height: 700 };
const ANCHOR: CalloutStar = { x: 500, y: 350, radius: 14 };
const CANDIDATES: CalloutCandidate[] = [
  { width: 240, contentHeight: 600, height: 392 },
  { width: 360, contentHeight: 440, height: 392 },
  { width: 520, contentHeight: 420, height: 392 },
];

function over(fromX: number, toX: number, stepX = 60, stepY = 60, radius = 9): CalloutStar[] {
  const stars: CalloutStar[] = [];
  for (let x = fromX; x <= toX; x += stepX) {
    for (let y = 40; y <= VIEWPORT.height - 40; y += stepY) stars.push({ x, y, radius });
  }
  return stars;
}

function place(options: {
  stars?: CalloutStar[];
  candidates?: CalloutCandidate[];
  previous?: ReturnType<typeof chooseCalloutPlacement>;
  anchor?: CalloutStar;
  viewport?: { width: number; height: number };
}) {
  return chooseCalloutPlacement({
    viewport: options.viewport ?? VIEWPORT,
    stars: options.stars ?? [],
    obstacles: [],
    anchor: options.anchor ?? ANCHOR,
    candidates: options.candidates ?? CANDIDATES,
    previous: options.previous ?? null,
  });
}

function covers(placement: NonNullable<ReturnType<typeof place>>, star: CalloutStar): boolean {
  return (
    star.x > placement.left &&
    star.x < placement.left + placement.width &&
    star.y > placement.top &&
    star.y < placement.top + placement.height
  );
}

describe("callout placement", () => {
  it("keeps the block inside the page", () => {
    const placement = place({ stars: over(0, 60) });
    expect(placement).not.toBeNull();
    const p = placement!;
    expect(p.left).toBeGreaterThanOrEqual(12);
    expect(p.top).toBeGreaterThanOrEqual(12);
    expect(p.left + p.width).toBeLessThanOrEqual(VIEWPORT.width - 12 + 0.001);
    expect(p.top + p.height).toBeLessThanOrEqual(VIEWPORT.height - 12 + 0.001);
  });

  it("flees to the empty side of a crowded picture", () => {
    const stars = over(40, 480);
    const placement = place({ stars })!;
    expect(placement.left).toBeGreaterThan(ANCHOR.x);
    for (const star of stars) expect(covers(placement, star)).toBe(false);
  });

  it("sits beside the star instead of straddling it", () => {
    const placement = place({ stars: over(560, 960) })!;
    expect(placement.left + placement.width).toBeLessThanOrEqual(ANCHOR.x + 1);
    expect(placement.side).toBe("right");
  });

  it("takes the widest width the free space affords", () => {
    // A page wide enough to seat the widest candidate beside the star.
    const placement = chooseCalloutPlacement({
      viewport: { width: 1600, height: 700 },
      stars: [],
      obstacles: [],
      anchor: { x: 800, y: 350, radius: 14 },
      candidates: CANDIDATES,
      previous: null,
    })!;
    expect(placement.width).toBe(520);
  });

  it("narrows into a tight corridor", () => {
    const corridor = over(300, 960, 40, 40, 12);
    const placement = place({ stars: corridor })!;
    expect(placement.width).toBe(240);
    expect(placement.left).toBeLessThan(300);
  });

  it("does not park under a canvas panel", () => {
    const placement = chooseCalloutPlacement({
      viewport: VIEWPORT,
      stars: [],
      obstacles: [{ left: 560, top: 12, width: 420, height: 120 }],
      anchor: ANCHOR,
      candidates: CANDIDATES,
      previous: null,
    })!;
    // The panel blocks the top right; the block either avoids it or sits
    // below it, never inside it.
    const under =
      placement.left >= 560 && placement.top + placement.height <= 12 && placement.top <= 132;
    expect(under).toBe(false);
    if (placement.left + placement.width > 560 && placement.top < 132) {
      expect(placement.top).toBeGreaterThanOrEqual(120);
    }
  });

  it("holds its spot while that spot is still among the best", () => {
    const first = place({ stars: over(0, 400) })!;
    const again = place({ stars: over(0, 400), previous: first })!;
    expect(again.left).toBe(first.left);
    expect(again.top).toBe(first.top);
    expect(again.width).toBe(first.width);
  });

  it("leaves a spot the picture has taken over", () => {
    const first = place({})!;
    const crowded = [
      ...over(0, 1000, 40, 40, 14),
      // Fill the spot's own area densely: staying there is now expensive.
      ...over(first.left, first.left + first.width, 24, 24, 14),
    ];
    const again = place({ stars: crowded, previous: first })!;
    expect(again.left !== first.left || again.top !== first.top).toBe(true);
  });

  it("re-solves when the content no longer fits the held spot", () => {
    const short = [{ width: 240, contentHeight: 60, height: 60 }];
    const viewport = { width: 1000, height: 700 };
    const first = chooseCalloutPlacement({
      viewport,
      stars: [],
      obstacles: [],
      anchor: ANCHOR,
      candidates: short,
      previous: null,
    })!;
    // The same spot with a much taller block would hang off the page.
    const tall = [{ width: 240, contentHeight: 600, height: 392 }];
    const again = chooseCalloutPlacement({
      viewport,
      stars: [],
      obstacles: [],
      anchor: ANCHOR,
      candidates: tall,
      previous: first,
    })!;
    expect(again.height).toBe(392);
    expect(again.top).toBeLessThanOrEqual(viewport.height - 12 - 392);
  });

  it("gives the leader a gap off the star and ends on the target", () => {
    const leader = calloutLeader({ x: 100, y: 100, radius: 12 }, { x: 300, y: 160 });
    expect(leader.x2).toBe(300);
    expect(leader.y2).toBe(160);
    expect(Math.hypot(leader.x1 - 100, leader.y1 - 100)).toBeCloseTo(26, 5);
    // The start sits on the segment towards the target.
    expect(leader.x1).toBeGreaterThan(100);
    expect(leader.y1).toBeGreaterThan(100);
    expect((leader.x1 - 100) / 26).toBeCloseTo((leader.x2 - 100) / Math.hypot(200, 60), 5);
  });
});

describe("callout sizing", () => {
  it("caps the height to a little over half the page", () => {
    expect(calloutHeightCap({ height: 700 })).toBeCloseTo(392, 5);
    expect(calloutHeightCap({ height: 2000 })).toBe(560);
    expect(calloutHeightCap({ height: 200 })).toBe(140);
  });

  it("offers widths that fit the page, widest last", () => {
    const wide = calloutWidths({ width: 1000 });
    expect(wide.at(-1)).toBe(520);
    expect(wide[0]).toBe(220);
    const narrow = calloutWidths({ width: 300 });
    expect(narrow.at(-1)).toBe(276);
    expect(Math.max(...narrow)).toBe(276);
    expect(calloutWidths({ width: 20 })).toEqual([]);
  });
});

describe("summary labels", () => {
  const focus = { x: 500, y: 350, radius: 18 };
  const candidates = [
    { key: "P1@A", id: "P1", x: 580, y: 350, radius: 8, scale: 1, hovered: false },
    { key: "P2@A", id: "P2", x: 420, y: 350, radius: 8, scale: 1, hovered: false },
    { key: "D3", id: "D3", x: 500, y: 250, radius: 12, scale: 0.6, hovered: false },
  ];
  const summaries = new Map([
    ["P1", "Short fact"],
    ["P2", "Another short fact"],
    ["D3", "Far"],
  ]);

  it("labels every candidate that has a summary, premise or decision", () => {
    const labels = placeSummaryLabels({ viewport: VIEWPORT, candidates, focus, summaries });
    expect(labels.map((label) => label.key)).toEqual(["P1@A", "P2@A", "D3"]);
    expect(labels[0]!.text).toBe("Short fact");
  });

  it("puts each summary outside its star, away from the centre", () => {
    const labels = placeSummaryLabels({ viewport: VIEWPORT, candidates, focus, summaries });
    expect(labels[0]!.left).toBeGreaterThan(580);
    expect(labels[1]!.left + labels[1]!.width).toBeLessThan(420);
  });

  it("gives each summary a rule and a leader back to its star", () => {
    const label = placeSummaryLabels({ viewport: VIEWPORT, candidates, focus, summaries })[0]!;
    const star = candidates[0]!;
    const { leader } = label;
    expect(label.side).toBe("left");
    expect(leader.x2).toBe(label.left);
    expect(leader.y2).toBe(label.top + label.ruleOffset);
    const start = Math.hypot(leader.x1 - star.x, leader.y1 - star.y);
    expect(start).toBeGreaterThan(2);
    expect(start).toBeLessThan(22);
    expect(label.ruleOffset).toBeGreaterThan(18);
  });

  it("carries the star so the view can re-aim the leader at the measured rule", () => {
    const label = placeSummaryLabels({ viewport: VIEWPORT, candidates, focus, summaries })[0]!;
    // Text wrapping decides the rule's real height; the estimate can be a
    // line too low, so the view measures the DOM and redraws from this anchor.
    expect(label.anchor).toEqual({
      x: candidates[0]!.x,
      y: candidates[0]!.y,
      radius: candidates[0]!.radius,
    });
  });

  it("shrinks a distant summary and its box together", () => {
    const labels = placeSummaryLabels({ viewport: VIEWPORT, candidates, focus, summaries });
    const near = labels[0]!;
    const far = labels[2]!;
    expect(far.scale).toBe(0.6);
    expect(far.width).toBeCloseTo(near.width * 0.6, 5);
    expect(far.height).toBeLessThan(near.height);
  });

  it("has an upper bound but no floor on label scale", () => {
    const tiny = [{ key: "D9", id: "D9", x: 500, y: 200, radius: 12, scale: 0.06, hovered: false }];
    const capped = [{ key: "D9", id: "D9", x: 500, y: 200, radius: 12, scale: 5, hovered: false }];
    const s = new Map([["D9", "Tiny"]]);
    expect(
      placeSummaryLabels({ viewport: VIEWPORT, candidates: tiny, focus, summaries: s })[0]!.scale,
    ).toBe(0.06);
    expect(
      placeSummaryLabels({ viewport: VIEWPORT, candidates: capped, focus, summaries: s })[0]!.scale,
    ).toBe(SUMMARY_SCALE_MAX);
  });

  it("scales every label with the settings text size", () => {
    const normal = placeSummaryLabels({ viewport: VIEWPORT, candidates, focus, summaries })[0]!;
    const large = placeSummaryLabels({
      viewport: VIEWPORT,
      candidates,
      focus,
      summaries,
      textScale: 1.5,
    })[0]!;
    expect(normal.scale).toBe(1);
    expect(large.scale).toBeCloseTo(1.5, 5);
    expect(large.width).toBeGreaterThan(normal.width);
    expect(large.ruleOffset).toBeGreaterThan(normal.ruleOffset);
    // A distant label stays proportionally smaller than a near one.
    const far = placeSummaryLabels({
      viewport: VIEWPORT,
      candidates,
      focus,
      summaries,
      textScale: 1.5,
    })[2]!;
    expect(far.scale).toBeCloseTo(0.9, 5);
  });

  it("keeps every label on the page and clear of the others", () => {
    const crowded = [
      { key: "P1@A", id: "P1", x: 540, y: 350, radius: 8, scale: 1, hovered: false },
      { key: "P2@A", id: "P2", x: 540, y: 354, radius: 8, scale: 1, hovered: false },
      { key: "P3@A", id: "P3", x: 540, y: 358, radius: 8, scale: 1, hovered: false },
    ];
    const labels = placeSummaryLabels({
      viewport: VIEWPORT,
      candidates: crowded,
      focus,
      summaries: new Map([
        ["P1", "One"],
        ["P2", "Two"],
        ["P3", "Three"],
      ]),
    });
    expect(labels).toHaveLength(3);
    for (const label of labels) {
      expect(label.left).toBeGreaterThanOrEqual(12);
      expect(label.top).toBeGreaterThanOrEqual(12);
      expect(label.left + label.width).toBeLessThanOrEqual(VIEWPORT.width - 12 + 0.001);
      expect(label.top + label.height).toBeLessThanOrEqual(VIEWPORT.height - 12 + 0.001);
    }
    for (let first = 0; first < labels.length; first++) {
      for (let second = first + 1; second < labels.length; second++) {
        const a = labels[first]!;
        const b = labels[second]!;
        const overlap =
          a.left < b.left + b.width &&
          a.left + a.width > b.left &&
          a.top < b.top + b.height &&
          a.top + a.height > b.top;
        expect(overlap).toBe(false);
      }
    }
  });

  it("keeps a label clear of a floating control", () => {
    const lone = [{ key: "P1@A", id: "P1", x: 580, y: 350, radius: 8, scale: 1, hovered: false }];
    const free = placeSummaryLabels({ viewport: VIEWPORT, candidates: lone, focus, summaries })[0]!;
    const control = {
      left: free.left,
      top: free.top,
      width: free.width,
      height: free.height,
    };
    const label = placeSummaryLabels({
      viewport: VIEWPORT,
      candidates: lone,
      focus,
      summaries,
      obstacles: [control],
    })[0]!;
    expect(
      label.left < control.left + control.width &&
        label.left + label.width > control.left &&
        label.top < control.top + control.height &&
        label.top + label.height > control.top,
    ).toBe(false);
  });

  it("omits stars without a displayed summary", () => {
    const labels = placeSummaryLabels({
      viewport: VIEWPORT,
      candidates,
      focus,
      summaries: new Map([["P1", "Only one"]]),
    });
    expect(labels.map((label) => label.key)).toEqual(["P1@A"]);
  });
});

describe("summaryScale", () => {
  it("reads 1 at the fitted distance and shrinks without a floor", () => {
    expect(summaryScale(100, 100)).toBeCloseTo(1, 5);
    expect(summaryScale(200, 100)).toBeCloseTo(0.5, 5);
    expect(summaryScale(400, 100)).toBeCloseTo(0.25, 5);
  });

  it("caps the too-close case only", () => {
    expect(summaryScale(50, 100)).toBeCloseTo(1.5, 5);
    expect(summaryScale(1, 100)).toBe(SUMMARY_SCALE_MAX);
  });
});
