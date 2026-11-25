/**
 * Screen-space geometry for the orbit callout (ui DESIGN.md, "三维视图"): the
 * focused star's content needs a hole in the picture to read in, and the hole
 * has to be found again on every turn of the camera.
 *
 * The page is rasterised into a coarse penalty field: every star claims a
 * hard disc with a soft halo, and the canvas panels claim their rectangles.
 * A summed-area table over that field scores a candidate rectangle in
 * constant time, which is what makes a full sweep over widths and positions
 * affordable on every update. A candidate costs:
 *
 * - the penalty it covers — nodes are avoided rather than merely not covered;
 * - the length of the leader, so the block stays near its star;
 * - the horizontal overlap with the star, so the block sits beside it and the
 *   leader can leave the rule's end without crossing the content;
 * - how much of the body the page-independent height cap hides, which widens
 *   the block while a wider block still reflows the text shorter;
 * - a small reward per pixel of width, which decides between otherwise equal
 *   spots in favour of the shorter, more readable block.
 *
 * The previous placement is kept while it still scores close to the best, so
 * a sweeping camera does not make the block hop between equal holes.
 *
 * Pure math: no DOM, no renderer, no camera.
 */

/** Keep-out radius of a star's glow and the soft halo around it, in CSS px. */
export const CALLOUT_PAD = 12;
/** Width the leader keeps off the focused star's glow. */
const LEADER_GAP = 14;
/** Vertical position of the rule inside the block: the leader's height cost
 * is scored against this estimate, not against the block's top. */
const RULE_INSET = 48;

const CELL = 16;
const STEP = 20;

const STAR_CORE = 8;
const STAR_EDGE = 2.4;
const STAR_HALO = 64;
const OBSTACLE = 24;

const LEADER_COST = 0.04;
const SIDE_COST = 1.6;
const SIDE_MARGIN = 16;
const CUT_COST = 60;
const WIDTH_REWARD = 0.03;
/** Score difference the previous placement may lose by before it is dropped. */
const KEEP_SLACK = 8;

/** Widest and narrowest the block may get; the ladder below stays inside. */
const MAX_WIDTH = 520;
const MIN_WIDTH = 180;
const WIDTH_STEPS = [220, 260, 300, 340, 380, 420, 460, 500];

export interface CalloutStar {
  /** Canvas-local CSS pixels. */
  x: number;
  y: number;
  /** On-screen glow radius: the disc the block must not cover. */
  radius: number;
}

export interface CalloutRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CalloutSize {
  width: number;
  height: number;
}

/** One width the block may take, with the heights it renders at. */
export interface CalloutCandidate {
  width: number;
  /** Rendered height: the content, capped by the page. */
  height: number;
  /** Height the content needs at this width before the cap. */
  contentHeight: number;
}

export interface CalloutPlacement {
  left: number;
  top: number;
  width: number;
  height: number;
  /** End of the rule the leader attaches to: the block's near side. */
  side: "left" | "right";
  /** Lower is better; exposed for the hysteresis and for tests. */
  score: number;
}

export interface CalloutInput {
  viewport: { width: number; height: number };
  stars: readonly CalloutStar[];
  /** Rectangles the block must not cover: the canvas edge controls. */
  obstacles: readonly CalloutRect[];
  /** The focused star. */
  anchor: CalloutStar;
  candidates: readonly CalloutCandidate[];
  /** Current placement, kept while it still scores close to the best. */
  previous: CalloutPlacement | null;
}

/** Tallest the block may grow at this page size: a little over half the
 * canvas, so the picture stays readable around it. */
export function calloutHeightCap(viewport: { height: number }): number {
  return Math.max(140, Math.min(viewport.height * 0.56, 560));
}

/** Widths the block may take at this page size, narrowest first. The ladder
 * ends at the widest the page affords, so a roomy hole still gets a wide
 * block; a narrow page trims it to what fits. */
export function calloutWidths(viewport: { width: number }): number[] {
  const widest = Math.min(MAX_WIDTH, viewport.width - 2 * CALLOUT_PAD);
  if (widest <= 0) return [];
  const widths = new Set<number>();
  for (const step of WIDTH_STEPS) {
    if (step <= widest) widths.add(step);
  }
  widths.add(Math.max(MIN_WIDTH, widest));
  return [...widths].sort((left, right) => left - right);
}

/** The leader from just outside the focused star's glow to the rule's near
 * end. It never touches the star: the start is held back by the star's glow
 * radius plus a gap. */
export function calloutLeader(
  anchor: CalloutStar,
  target: { x: number; y: number },
): { x1: number; y1: number; x2: number; y2: number } {
  const dx = target.x - anchor.x;
  const dy = target.y - anchor.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-3) return { x1: anchor.x, y1: anchor.y, x2: target.x, y2: target.y };
  const start = Math.min(anchor.radius + LEADER_GAP, length * 0.5);
  return {
    x1: anchor.x + (dx / length) * start,
    y1: anchor.y + (dy / length) * start,
    x2: target.x,
    y2: target.y,
  };
}

/** The end of the rule the leader attaches to: the side facing the star. */
function sideOf(anchor: CalloutStar, left: number, width: number): "left" | "right" {
  const right = left + width;
  if (anchor.x <= left) return "left";
  if (anchor.x >= right) return "right";
  return anchor.x - left <= right - anchor.x ? "left" : "right";
}

interface PenaltyField {
  cols: number;
  rows: number;
  /** Prefix sums over (cols + 1) x (rows + 1) cells. */
  sums: Float64Array;
}

function buildField(
  viewport: { width: number; height: number },
  stars: readonly CalloutStar[],
  obstacles: readonly CalloutRect[],
): PenaltyField {
  const cols = Math.max(1, Math.ceil(viewport.width / CELL));
  const rows = Math.max(1, Math.ceil(viewport.height / CELL));
  const cells = new Float32Array(cols * rows);
  for (const star of stars) paintStar(cells, cols, rows, star);
  for (const rect of obstacles) paintRect(cells, cols, rows, rect);
  const stride = cols + 1;
  const sums = new Float64Array(stride * (rows + 1));
  for (let row = 0; row < rows; row++) {
    let run = 0;
    for (let col = 0; col < cols; col++) {
      run += cells[row * cols + col]!;
      sums[(row + 1) * stride + col + 1] = sums[row * stride + col + 1]! + run;
    }
  }
  return { cols, rows, sums };
}

function paintStar(cells: Float32Array, cols: number, rows: number, star: CalloutStar): void {
  const reach = star.radius + STAR_HALO;
  const firstCol = Math.max(0, Math.floor((star.x - reach) / CELL));
  const lastCol = Math.min(cols - 1, Math.floor((star.x + reach) / CELL));
  const firstRow = Math.max(0, Math.floor((star.y - reach) / CELL));
  const lastRow = Math.min(rows - 1, Math.floor((star.y + reach) / CELL));
  for (let row = firstRow; row <= lastRow; row++) {
    const dy = (row + 0.5) * CELL - star.y;
    for (let col = firstCol; col <= lastCol; col++) {
      const dx = (col + 0.5) * CELL - star.x;
      const distance = Math.hypot(dx, dy);
      let penalty = 0;
      if (distance <= star.radius) {
        penalty = STAR_CORE;
      } else {
        const t = (distance - star.radius) / STAR_HALO;
        if (t < 1) penalty = STAR_EDGE * (1 - t) ** 2;
      }
      if (penalty > 0) cells[row * cols + col]! += penalty;
    }
  }
}

function paintRect(cells: Float32Array, cols: number, rows: number, rect: CalloutRect): void {
  const firstCol = Math.max(0, Math.floor(rect.left / CELL));
  const lastCol = Math.min(cols - 1, Math.floor((rect.left + rect.width) / CELL));
  const firstRow = Math.max(0, Math.floor(rect.top / CELL));
  const lastRow = Math.min(rows - 1, Math.floor((rect.top + rect.height) / CELL));
  for (let row = firstRow; row <= lastRow; row++) {
    for (let col = firstCol; col <= lastCol; col++) cells[row * cols + col]! += OBSTACLE;
  }
}

function fieldSum(field: PenaltyField, rect: CalloutRect): number {
  const stride = field.cols + 1;
  const colFrom = clamp(Math.floor(rect.left / CELL), 0, field.cols);
  const colTo = clamp(Math.ceil((rect.left + rect.width) / CELL), 0, field.cols);
  const rowFrom = clamp(Math.floor(rect.top / CELL), 0, field.rows);
  const rowTo = clamp(Math.ceil((rect.top + rect.height) / CELL), 0, field.rows);
  return (
    field.sums[rowTo * stride + colTo]! -
    field.sums[rowFrom * stride + colTo]! -
    field.sums[rowTo * stride + colFrom]! +
    field.sums[rowFrom * stride + colFrom]!
  );
}

function scorePlacement(
  field: PenaltyField,
  anchor: CalloutStar,
  placement: CalloutRect,
  contentHeight: number,
): number {
  const side = sideOf(anchor, placement.left, placement.width);
  const attachX = side === "left" ? placement.left : placement.left + placement.width;
  const attachY = placement.top + Math.min(placement.height, RULE_INSET);
  const distance = Math.hypot(attachX - anchor.x, attachY - anchor.y);
  const overlap = Math.max(
    0,
    Math.min(placement.left + placement.width, anchor.x + SIDE_MARGIN) -
      Math.max(placement.left, anchor.x - SIDE_MARGIN),
  );
  const cut = contentHeight > 0 ? 1 - Math.min(placement.height, contentHeight) / contentHeight : 0;
  return (
    fieldSum(field, placement) +
    distance * LEADER_COST +
    overlap * SIDE_COST +
    cut * CUT_COST -
    placement.width * WIDTH_REWARD
  );
}

/**
 * Best spot for the block at this instant, or null when the page affords no
 * size at all. Positions are swept on a coarse grid: the block eases towards
 * the winner, so grid granularity never shows.
 */
export function chooseCalloutPlacement(input: CalloutInput): CalloutPlacement | null {
  const { viewport, anchor, candidates } = input;
  const maxWidth = viewport.width - 2 * CALLOUT_PAD;
  const maxHeight = viewport.height - 2 * CALLOUT_PAD;
  if (candidates.length === 0 || maxWidth <= 0 || maxHeight <= 0) return null;
  const field = buildField(viewport, input.stars, input.obstacles);
  let best: CalloutPlacement | null = null;
  for (const candidate of candidates) {
    const width = Math.min(candidate.width, maxWidth);
    const height = Math.min(candidate.height, maxHeight);
    const maxLeft = viewport.width - CALLOUT_PAD - width;
    const maxTop = viewport.height - CALLOUT_PAD - height;
    for (let top = CALLOUT_PAD; ; top = Math.min(top + STEP, maxTop)) {
      for (let left = CALLOUT_PAD; ; left = Math.min(left + STEP, maxLeft)) {
        const score = scorePlacement(
          field,
          anchor,
          { left, top, width, height },
          candidate.contentHeight,
        );
        if (best === null || score < best.score) {
          best = { left, top, width, height, side: sideOf(anchor, left, width), score };
        }
        if (left >= maxLeft) break;
      }
      if (top >= maxTop) break;
    }
  }
  if (best === null) return null;
  const previous = input.previous;
  if (previous !== null) {
    // The content may have grown since the previous solution: hold the spot
    // only at the size the block would have there today.
    const candidate = closestCandidate(previous.width, candidates);
    const width = Math.min(candidate.width, maxWidth);
    const height = Math.min(candidate.height, maxHeight);
    const kept = { left: previous.left, top: previous.top, width, height };
    if (inBounds(kept, viewport)) {
      const score = scorePlacement(field, anchor, kept, candidate.contentHeight);
      if (score <= best.score + KEEP_SLACK) {
        return { ...kept, side: sideOf(anchor, kept.left, width), score };
      }
    }
  }
  return best;
}

/** Candidate closest to `width`: a resize can drop the width that was used. */
function closestCandidate(
  width: number,
  candidates: readonly CalloutCandidate[],
): CalloutCandidate {
  let closest = candidates[0]!;
  for (const candidate of candidates) {
    if (Math.abs(candidate.width - width) < Math.abs(closest.width - width)) closest = candidate;
  }
  return closest;
}

function inBounds(placement: CalloutRect, viewport: { width: number; height: number }): boolean {
  return (
    placement.left >= CALLOUT_PAD - 0.5 &&
    placement.top >= CALLOUT_PAD - 0.5 &&
    placement.left + placement.width <= viewport.width - CALLOUT_PAD + 0.5 &&
    placement.top + placement.height <= viewport.height - CALLOUT_PAD + 0.5
  );
}

/** Width of a summary at full size; one line's height. */
export const SUMMARY_LABEL_WIDTH = 168;
export const SUMMARY_LABEL_LINE = 19;
/** Font size of a summary at full scale. */
export const SUMMARY_FONT_SIZE = 13;
const SUMMARY_LABEL_LINES = 2;
/** Rule under a summary, with the same gap as the main block. */
export const SUMMARY_RULE_GAP = 6;
const SUMMARY_RULE_HEIGHT = 1;
/** Gap between a star's glow and its text. */
const SUMMARY_GAP = 10;
/** Step used to push a label aside when it meets another label. */
const SUMMARY_NUDGE = 14;

export interface SummaryLabelCandidate extends CalloutStar {
  key: string;
  id: string;
  /** Font size multiplier from the distance; 1 is the normal, maximum size. */
  scale: number;
  /** Hovered right now: its label may unfold the body under the rule. */
  hovered: boolean;
}

export interface SummaryLabelInput {
  viewport: { width: number; height: number };
  /** Stars that earned a summary, already ranked and distance-scaled. */
  candidates: readonly SummaryLabelCandidate[];
  /** Centre of attention: labels are pushed away from it. */
  focus: CalloutStar | null;
  summaries: ReadonlyMap<string, string>;
  /** Font scale from the orbit settings; 1 keeps the designed size. */
  textScale?: number;
  /** Floating controls the labels must stay clear of, in canvas-local px. */
  obstacles?: readonly CalloutRect[];
}

export interface SummaryLabelPlacement extends CalloutRect {
  key: string;
  /** Data node id, for the hovered label's body. */
  id: string;
  text: string;
  /** Text size multiplier, mirrored into the DOM. */
  scale: number;
  /** Hovered now: the Alt key unfolds this label's body. */
  hovered: boolean;
  /** Where the rule sits inside the box; the leader ends at its near tip. */
  ruleOffset: number;
  /** Side of the box facing the star. */
  side: "left" | "right";
  /** Leader from just outside the star's glow to the rule's near tip. */
  leader: { x1: number; y1: number; x2: number; y2: number };
  /**
   * The star behind the label. The DOM measures the rule's real position
   * (text wrapping differs from the estimate) and redraws the leader from
   * this anchor; pure placement keeps the estimate as its fallback.
   */
  anchor: CalloutStar;
}

/**
 * Summary labels for the stars that earned one. Each sits just outside its
 * own star, away from the centre of attention, with the same rule and leader
 * as the main block (only the body is missing). Labels are nudged apart while
 * overlapping, and their boxes double as obstacles for the main block, so the
 * two never sit on top of each other.
 */
export function placeSummaryLabels(input: SummaryLabelInput): SummaryLabelPlacement[] {
  const { viewport, focus, summaries, obstacles = [] } = input;
  const result: SummaryLabelPlacement[] = [];
  for (const candidate of input.candidates) {
    const text = summaries.get(candidate.id);
    if (text === undefined || text === "") continue;
    // Upper bound only: distance decides how small a label gets, the settings
    // text scale multiplies that size.
    const scale = Math.min(1, candidate.scale) * Math.max(0.1, input.textScale ?? 1);
    const width = Math.min(SUMMARY_LABEL_WIDTH * scale, viewport.width - 2 * CALLOUT_PAD);
    if (width <= 0) continue;
    const lines = Math.min(SUMMARY_LABEL_LINES, Math.max(1, Math.ceil(text.length / 12)));
    const ruleOffset = lines * SUMMARY_LABEL_LINE * scale + SUMMARY_RULE_GAP * scale;
    const height = ruleOffset + SUMMARY_RULE_HEIGHT;
    let dx = 1;
    let dy = 0;
    if (focus !== null) {
      dx = candidate.x - focus.x;
      dy = candidate.y - focus.y;
      const length = Math.hypot(dx, dy);
      if (length > 1e-3) {
        dx /= length;
        dy /= length;
      } else {
        dx = 1;
        dy = 0;
      }
    }
    const reach = candidate.radius + SUMMARY_GAP;
    const baseLeft = candidate.x + dx * reach;
    const left0 = dx < 0 ? baseLeft - width : baseLeft;
    const top0 = candidate.y + dy * reach - height / 2;
    const attempts = [{ left: left0, top: top0 }];
    // Push outwards first, then sideways: stars on a ring often line up on
    // screen, so a radial nudge alone cannot separate their labels.
    for (let ring = 1; ring <= 8; ring++) {
      const outward = ring * SUMMARY_NUDGE;
      const sideways = ring * (SUMMARY_LABEL_LINE * scale + 4);
      attempts.push(
        { left: left0 + dx * outward, top: top0 },
        { left: left0, top: top0 + sideways },
        { left: left0, top: top0 - sideways },
        { left: left0 + dx * outward, top: top0 + sideways },
        { left: left0 + dx * outward, top: top0 - sideways },
      );
    }
    let chosen = attempts[0]!;
    for (const attempt of attempts) {
      const left = clamp(
        attempt.left,
        CALLOUT_PAD,
        Math.max(CALLOUT_PAD, viewport.width - CALLOUT_PAD - width),
      );
      const top = clamp(
        attempt.top,
        CALLOUT_PAD,
        Math.max(CALLOUT_PAD, viewport.height - CALLOUT_PAD - height),
      );
      chosen = { left, top };
      const overlaps =
        result.some(
          (box) =>
            left < box.left + box.width &&
            left + width > box.left &&
            top < box.top + box.height &&
            top + height > box.top,
        ) ||
        obstacles.some(
          (box) =>
            left < box.left + box.width &&
            left + width > box.left &&
            top < box.top + box.height &&
            top + height > box.top,
        );
      if (!overlaps) break;
    }
    const side = sideOf(candidate, chosen.left, width);
    const leader = calloutLeader(candidate, {
      x: side === "left" ? chosen.left : chosen.left + width,
      y: chosen.top + ruleOffset,
    });
    result.push({
      key: candidate.key,
      id: candidate.id,
      text,
      scale,
      hovered: candidate.hovered,
      ...chosen,
      width,
      height,
      ruleOffset,
      side,
      leader,
      anchor: { x: candidate.x, y: candidate.y, radius: candidate.radius },
    });
  }
  return result;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
