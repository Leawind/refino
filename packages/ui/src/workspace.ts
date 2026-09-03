import { computed, reactive, readonly, shallowRef } from "vue";
import {
  connectEvents,
  fetchIssues,
  queryGrounds,
  queryNeighbors,
  queryRange,
  querySiblings,
  reloadGraph,
} from "./api";
import { readNumberPreference, readPreference, writePreference } from "./preferences";
import type { ChangeEvent, IssueRecord, NodeLite } from "./types";

/**
 * On-demand working set state (docs/design.md, "画布按需查询"; @refino/ui
 * README, "数据：按需工作集").
 *
 * The full graph is never loaded. The canvas renders the working set: the
 * union of the selected nodes' neighborhoods and strong siblings, range
 * selection paths (which join the selection) and the hovered node's
 * temporary grounds. Nodes keep their identity in `liteCache` when they
 * leave the working set so re-entry is instant.
 *
 * Selection is an ordered, duplicate-free id list; the focus is its last
 * element. External changes arrive over SSE and re-expand the selection, so
 * the working set is always rebuilt from fresh server data.
 */

export interface CanvasConfig {
  /** Ancestor generations fetched per anchor. Direct grounds are always fetched. */
  ancestorDepth: number;
  /** Descendant constraint generations fetched per anchor. */
  descendantDepth: number;
  /** Whether strong siblings of the selection join the working set. */
  showSiblings: boolean;
  /** Sibling candidates kept per anchor (overlap-descending, id-ascending). */
  siblingLimit: number;
  /** Per-anchor neighborhood truncation limit (nearest-first). */
  neighborhoodLimit: number;
}

const DEFAULT_CONFIG: CanvasConfig = {
  ancestorDepth: 2,
  descendantDepth: 2,
  showSiblings: true,
  siblingLimit: 24,
  neighborhoodLimit: 400,
};

const CONFIG_KEYS: Record<keyof CanvasConfig, string> = {
  ancestorDepth: "refino.canvas.ancestorDepth",
  descendantDepth: "refino.canvas.descendantDepth",
  showSiblings: "refino.canvas.showSiblings",
  siblingLimit: "refino.canvas.siblingLimit",
  neighborhoodLimit: "refino.canvas.neighborhoodLimit",
};

/** Why the last range selection degraded to just the clicked node. */
export type RangeNotice = "rangeDegraded" | "rangeDisconnected";

interface WorkspaceState {
  /** False until the first successful expansion. */
  ready: boolean;
  loading: boolean;
  error: string | null;
  revision: number;
  issues: IssueRecord[];
  /** SSE stream open; false also when EventSource is unavailable. */
  connected: boolean;
  /** The current working set hit a server-side truncation limit. */
  truncated: boolean;
  selection: string[];
  focusId: string | null;
  hoveredId: string | null;
  notice: RangeNotice | null;
  config: CanvasConfig;
}

function loadConfig(): CanvasConfig {
  return {
    ancestorDepth: readNumberPreference(CONFIG_KEYS.ancestorDepth, DEFAULT_CONFIG.ancestorDepth),
    descendantDepth: readNumberPreference(
      CONFIG_KEYS.descendantDepth,
      DEFAULT_CONFIG.descendantDepth,
    ),
    showSiblings:
      readPreference(CONFIG_KEYS.showSiblings, String(DEFAULT_CONFIG.showSiblings)) === "true",
    siblingLimit: readNumberPreference(CONFIG_KEYS.siblingLimit, DEFAULT_CONFIG.siblingLimit),
    neighborhoodLimit: readNumberPreference(
      CONFIG_KEYS.neighborhoodLimit,
      DEFAULT_CONFIG.neighborhoodLimit,
    ),
  };
}

const state = reactive<WorkspaceState>({
  ready: false,
  loading: false,
  error: null,
  revision: 0,
  issues: [],
  connected: false,
  truncated: false,
  selection: [],
  focusId: null,
  hoveredId: null,
  notice: null,
  config: loadConfig(),
});

/** Light shapes currently in the working set (rebuilt per expansion). */
const workingSet = shallowRef(new Map<string, NodeLite>());
/** Grounds of the hovered node; merged into the display while hovering. */
const hoverSet = shallowRef(new Map<string, NodeLite>());

/** Every lite shape ever seen; evicted working-set nodes stay here for
 * quick restore. Pruned only on deletion events. */
const liteCache = new Map<string, NodeLite>();

function prime(lite: NodeLite): void {
  liteCache.set(lite.id, lite);
}

/** Refreshes are asynchronous; only the latest one may touch the state. */
let refreshToken = 0;
let hoverToken = 0;
let stopEvents: (() => void) | null = null;

function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Fresh lite shapes for the anchors themselves: neighborhood results exclude
 * their anchors, and selection sources (search hits, canvas clicks) may
 * carry stale or missing grounds, so anchors are re-read on every expansion.
 * `range(id, id)` returns the single node with full lite shape.
 */
async function refreshAnchors(ids: readonly string[]): Promise<void> {
  await Promise.all(
    ids.map((id) =>
      queryRange(id, id)
        .then((result) => {
          const node = result.nodes[0];
          if (node !== undefined) prime(node);
        })
        .catch(() => {
          // The anchor may have vanished mid-refresh; the working set simply
          // keeps whatever cached shape exists until SSE prunes it.
        }),
    ),
  );
}

/** Rebuild the working set from the current selection. */
async function refresh(): Promise<void> {
  const token = ++refreshToken;
  const anchors = dedupe(state.selection);
  if (anchors.length === 0) {
    workingSet.value = new Map();
    state.truncated = false;
    state.ready = true;
    return;
  }
  state.loading = true;
  try {
    await refreshAnchors(anchors);

    const siblingIds = new Set<string>();
    let siblingsTruncated = false;
    if (state.config.showSiblings) {
      const groups = await querySiblings(anchors, state.config.siblingLimit);
      for (const group of groups) {
        if ("error" in group) continue;
        const set = group.results[0];
        if (set === undefined) continue;
        siblingsTruncated ||= set.truncated;
        for (const node of set.nodes) {
          prime(node);
          siblingIds.add(node.id);
        }
      }
    }

    // Direct grounds are part of the neighborhood contract regardless of N.
    const groups = await queryNeighbors(dedupe([...anchors, ...siblingIds]), {
      ancestorDepth: Math.max(state.config.ancestorDepth, 1),
      descendantDepth: state.config.descendantDepth,
      limit: state.config.neighborhoodLimit,
    });
    let neighborsTruncated = false;
    const coverage = new Set([...anchors, ...siblingIds]);
    for (const group of groups) {
      if ("error" in group) continue;
      const neighborhood = group.results[0];
      if (neighborhood === undefined) continue;
      neighborsTruncated ||= neighborhood.truncated;
      for (const node of neighborhood.nodes) {
        prime(node);
        coverage.add(node.id);
      }
    }

    const map = new Map<string, NodeLite>();
    for (const id of coverage) {
      const lite = liteCache.get(id);
      if (lite !== undefined) map.set(id, lite);
    }
    if (token !== refreshToken) return;
    workingSet.value = map;
    state.truncated = siblingsTruncated || neighborsTruncated;
    state.error = null;
    state.ready = true;
  } catch (error) {
    // Keep the previous working set on transient failures.
    if (token === refreshToken)
      state.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (token === refreshToken) state.loading = false;
  }
}

function setSelection(ids: string[]): void {
  state.selection = ids;
  state.focusId = ids[ids.length - 1] ?? null;
}

/** Left click: make this the only selected node. */
function select(lite: NodeLite): void {
  prime(lite);
  if (sameSelection(state.selection, [lite.id])) return;
  setSelection([lite.id]);
  state.notice = null;
  void refresh();
}

/** Shift click: append the range between focus and the clicked node. */
async function rangeSelect(lite: NodeLite): Promise<void> {
  prime(lite);
  const focusId = state.focusId;
  if (focusId === null || focusId === lite.id) {
    select(lite);
    return;
  }
  try {
    const result = await queryRange(focusId, lite.id);
    for (const node of result.nodes) prime(node);
    if (result.mode === "ancestor") {
      appendSelection(result.nodes.map((node) => node.id));
    } else {
      // No common ancestor within the budget (definitively or before the
      // budget ran out): only the clicked node joins, per design.
      appendSelection([lite.id]);
      state.notice = result.mode === "disconnected" ? "rangeDisconnected" : "rangeDegraded";
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    return;
  }
  await refresh();
}

function appendSelection(ids: readonly string[]): void {
  const next = [...state.selection];
  for (const id of ids) if (!next.includes(id)) next.push(id);
  setSelection(next);
}

/** Ctrl click: toggle a constraint's membership; premises are unaffected. */
function toggle(lite: NodeLite): void {
  if (lite.type !== "constraint") return;
  prime(lite);
  const index = state.selection.indexOf(lite.id);
  if (index >= 0) setSelection(state.selection.filter((id) => id !== lite.id));
  else setSelection([...state.selection, lite.id]);
  void refresh();
}

/** Selection list "locate": move the node to the end, making it the focus. */
function setFocus(id: string): void {
  if (!state.selection.includes(id)) return;
  setSelection([...state.selection.filter((existing) => existing !== id), id]);
}

function removeFromSelection(id: string): void {
  if (!state.selection.includes(id)) return;
  setSelection(state.selection.filter((existing) => existing !== id));
  void refresh();
}

function clearSelection(): void {
  if (state.selection.length === 0) return;
  setSelection([]);
  state.hoveredId = null;
  hoverSet.value = new Map();
  void refresh();
}

/** Hover: the node's direct grounds fade in as temporary working-set nodes. */
async function hover(id: string): Promise<void> {
  state.hoveredId = id;
  const lite = liteCache.get(id);
  if (lite === undefined || lite.type !== "constraint") return;
  const token = ++hoverToken;
  try {
    const groups = await queryGrounds([id]);
    const grounds = new Map<string, NodeLite>();
    for (const group of groups) {
      if ("error" in group) continue;
      for (const node of group.results) {
        prime(node);
        grounds.set(node.id, node);
      }
    }
    if (token === hoverToken && state.hoveredId === id) hoverSet.value = grounds;
  } catch {
    // Hover extras are best-effort.
  }
}

function unhover(): void {
  state.hoveredId = null;
  hoverToken++;
  hoverSet.value = new Map();
}

function dismissNotice(): void {
  state.notice = null;
}

function dismissError(): void {
  state.error = null;
}

/** Drop deleted nodes from every layer; selection shrinks accordingly. */
function pruneDeleted(ids: readonly string[]): void {
  const deleted = new Set(ids);
  if (deleted.size === 0) return;
  for (const id of deleted) liteCache.delete(id);
  if (state.hoveredId !== null && deleted.has(state.hoveredId)) unhover();
  if (state.selection.some((id) => deleted.has(id))) {
    setSelection(state.selection.filter((id) => !deleted.has(id)));
  }
  void refresh();
}

async function refreshIssues(): Promise<void> {
  try {
    const result = await fetchIssues();
    state.issues = result.issues;
    state.revision = result.revision;
  } catch {
    // Issue counts are advisory; leave the previous value in place.
  }
}

function applyEvent(event: ChangeEvent): void {
  state.revision = event.revision;
  // Re-expand on every batch (changed ids may be new dependents or fresh
  // grounds of working-set nodes); the server batches events at 500ms.
  if (event.deleted.length > 0) pruneDeleted(event.deleted);
  else void refresh();
  void refreshIssues();
}

/** Begin lifecycle: subscribe to the change feed and fetch issues. The
 * canvas stays empty until the first selection. */
function start(): void {
  if (stopEvents !== null) return;
  stopEvents = connectEvents(applyEvent, (connected) => {
    state.connected = connected;
  });
  void refreshIssues();
}

function stop(): void {
  stopEvents?.();
  stopEvents = null;
}

/** Manual authoritative refresh (header button): full server rescan; the
 * SSE feed re-expands the working set, and local state follows immediately. */
async function reload(): Promise<void> {
  try {
    const event = await reloadGraph();
    applyEvent(event);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  }
}

function setConfig(patch: Partial<CanvasConfig>): void {
  // Writes go through an unknown-valued view: a union key's write type is
  // the intersection of the property types, which is `never` here.
  const target = state.config as Record<keyof CanvasConfig, unknown>;
  for (const key of Object.keys(patch) as Array<keyof CanvasConfig>) {
    const value = patch[key];
    if (value === undefined) continue;
    target[key] = value;
    writePreference(CONFIG_KEYS[key], String(value));
  }
  void refresh();
}

/**
 * Nodes the canvas draws: every constraint of the working set, plus premises
 * that are selected or directly ground a selected/hovered constraint
 * (README, "显示规则与样式"). Edges come from the grounds of the displayed
 * constraints, so both endpoints are always present.
 */
const displayed = computed<NodeLite[]>(() => {
  const merged = new Map(workingSet.value);
  for (const [id, node] of hoverSet.value) merged.set(id, node);
  const pinned = new Set(state.selection);
  if (state.hoveredId !== null) pinned.add(state.hoveredId);

  const constraints: NodeLite[] = [];
  const showPremise = new Set<string>();
  for (const node of merged.values()) {
    if (node.type !== "constraint") continue;
    constraints.push(node);
    if (pinned.has(node.id)) for (const ground of node.grounds ?? []) showPremise.add(ground);
  }
  const result = [...constraints];
  for (const node of merged.values()) {
    if (node.type === "premise" && (pinned.has(node.id) || showPremise.has(node.id)))
      result.push(node);
  }
  return result;
});

/** Lite shapes of the ordered selection, for the selection list UI. */
const selectedNodes = computed<NodeLite[]>(() =>
  state.selection.map((id) => liteCache.get(id)).filter((n) => n !== undefined),
);

export const workspace = {
  state: readonly(state),
  /** Working-set nodes the canvas displays, in stable order. */
  displayed,
  selectedNodes,
  start,
  stop,
  reload,
  select,
  rangeSelect,
  toggle,
  setFocus,
  removeFromSelection,
  clearSelection,
  hover,
  unhover,
  dismissNotice,
  dismissError,
  setConfig,
  /** Re-expand the working set from the current selection (used after local
   * mutations when the SSE feed is unavailable). */
  refresh: (): Promise<void> => refresh(),
  /** Drop nodes deleted by a local mutation; SSE carries external deletions. */
  pruneDeleted,
  /** Internal test seam. */
  isLive: () => stopEvents !== null,
};
