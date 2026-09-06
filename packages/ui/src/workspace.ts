import { computed, reactive, readonly, shallowRef, type InjectionKey } from "vue";
import type { RefinoClient } from "./api";
import { readNumberPreference, readPreference, writePreference } from "./preferences";
import { TEXT_SCALE_MAX, TEXT_SCALE_MIN } from "./graph/render/renderer";
import type { LayoutMode } from "./graph/layout/types";
import type { ChangeEvent, IssueRecord, LayoutDirection, NodeLite } from "./types";

/**
 * Accumulated working-set state (docs/design.md, "画布按需查询"; @refino/ui
 * README, "数据：按需工作集").
 *
 * The full graph is never loaded. Each selection change expands one block
 * per selected node (full upstream closure, bounded descendants, strong
 * siblings) and merges it into the working set — earlier content stays on
 * the canvas, so exploring accumulates. Only the total working-set limit
 * evicts, least recently visited first (selection immune). Clearing the
 * selection keeps the canvas; the content resets only via deletion events.
 * Premise nodes are not displayed (ui README, "显示规则与样式"). Nodes keep
 * their identity in `liteCache` when evicted so re-entry is instant.
 *
 * Selection is an ordered, duplicate-free id list; the focus is its last
 * element. External changes arrive over SSE and refresh both the selection's
 * expansions and the lite shapes of accumulated nodes, so the working set
 * never goes stale.
 */

export interface CanvasConfig {
  /** Descendant constraint generations fetched per anchor. */
  descendantDepth: number;
  /** Whether strong siblings of the selection join the working set. */
  showSiblings: boolean;
  /** Whether premise nodes render on the canvas as the facts layer. */
  showPremises: boolean;
  /** Sibling candidates kept per anchor (overlap-descending, id-ascending). */
  siblingLimit: number;
  /** Total nodes the working set keeps; over the limit, least recently
   * visited non-selected nodes are evicted (ui README, "数据：按需工作集"). */
  workingSetLimit: number;
  /** Render budget mode: estimated from viewport/hardware, or pinned. */
  budgetMode: "auto" | "manual";
  /** Manual render budget in cost units (budgetMode "manual"). */
  budgetManual: number;
  /** Zoom anchor for wheel zooming. */
  zoomAnchor: "cursor" | "center";
  /** Maximum zoom scale. */
  zoomMax: number;
  /** Canvas text size multiplier (style settings panel). */
  textScale: number;
  /** Canvas layout algorithm. */
  layoutMode: LayoutMode;
  /** Display direction for directional layouts (force ignores it). */
  direction: LayoutDirection;
}

const DEFAULT_CONFIG: CanvasConfig = {
  descendantDepth: 2,
  showSiblings: true,
  showPremises: true,
  siblingLimit: 24,
  workingSetLimit: 2000,
  budgetMode: "auto",
  budgetManual: 6000,
  zoomAnchor: "cursor",
  zoomMax: 4,
  textScale: 1,
  layoutMode: "layered",
  direction: "LR",
};

const CONFIG_KEYS: Record<keyof CanvasConfig, string> = {
  descendantDepth: "refino.canvas.descendantDepth",
  showSiblings: "refino.canvas.showSiblings",
  showPremises: "refino.canvas.showPremises",
  siblingLimit: "refino.canvas.siblingLimit",
  workingSetLimit: "refino.canvas.workingSetLimit",
  budgetMode: "refino.canvas.budgetMode",
  budgetManual: "refino.canvas.budgetManual",
  zoomAnchor: "refino.canvas.zoomAnchor",
  zoomMax: "refino.canvas.zoomMax",
  textScale: "refino.canvas.textScale",
  layoutMode: "refino.canvas.layoutMode",
  direction: "refino.canvas.direction",
};

/** Why the last range selection degraded to just the clicked node. */
export type RangeNotice = "rangeDisconnected";

/** Root candidates fetched for the cold-start seed (`/api/search` cap). */
const ROOT_SEED_LIMIT = 500;

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
    descendantDepth: readNumberPreference(
      CONFIG_KEYS.descendantDepth,
      DEFAULT_CONFIG.descendantDepth,
    ),
    showSiblings:
      readPreference(CONFIG_KEYS.showSiblings, String(DEFAULT_CONFIG.showSiblings)) === "true",
    showPremises:
      readPreference(CONFIG_KEYS.showPremises, String(DEFAULT_CONFIG.showPremises)) === "true",
    siblingLimit: readNumberPreference(CONFIG_KEYS.siblingLimit, DEFAULT_CONFIG.siblingLimit),
    workingSetLimit: Math.max(
      1,
      readNumberPreference(CONFIG_KEYS.workingSetLimit, DEFAULT_CONFIG.workingSetLimit),
    ),
    budgetMode:
      readPreference(CONFIG_KEYS.budgetMode, DEFAULT_CONFIG.budgetMode) === "manual"
        ? "manual"
        : "auto",
    budgetManual: Math.max(
      64,
      readNumberPreference(CONFIG_KEYS.budgetManual, DEFAULT_CONFIG.budgetManual),
    ),
    zoomAnchor:
      readPreference(CONFIG_KEYS.zoomAnchor, DEFAULT_CONFIG.zoomAnchor) === "center"
        ? "center"
        : "cursor",
    zoomMax: Math.max(0.5, readNumberPreference(CONFIG_KEYS.zoomMax, DEFAULT_CONFIG.zoomMax)),
    textScale: Math.min(
      TEXT_SCALE_MAX,
      Math.max(
        TEXT_SCALE_MIN,
        readNumberPreference(CONFIG_KEYS.textScale, DEFAULT_CONFIG.textScale),
      ),
    ),
    layoutMode:
      readPreference(CONFIG_KEYS.layoutMode, DEFAULT_CONFIG.layoutMode) === "force"
        ? "force"
        : "layered",
    direction: parseDirection(readPreference(CONFIG_KEYS.direction, DEFAULT_CONFIG.direction)),
  };
}

/** Anything but the four spelled-out directions falls back to "LR". */
function parseDirection(raw: string): LayoutDirection {
  return raw === "TB" || raw === "RL" || raw === "BT" ? raw : "LR";
}

/** One workspace instance: working-set state, selection and change
 * subscription over one injected client (docs/design.md, "前端技术栈"). */
export function createWorkspace(client: RefinoClient) {
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
  /** External-change listeners (applied SSE/reload events, post-pruning). */
  const changeListeners = new Set<(event: ChangeEvent) => void>();

  /** Every lite shape ever seen; evicted working-set nodes stay here for
   * quick restore. Pruned only on deletion events. */
  const liteCache = new Map<string, NodeLite>();

  /** LRU bookkeeping for eviction: a monotonic clock stamping nodes each
   * time they join an expansion or the selection. */
  const lastVisited = new Map<string, number>();
  let visitClock = 0;

  function prime(lite: NodeLite): void {
    liteCache.set(lite.id, lite);
  }

  /** Refreshes are asynchronous; only the latest one may touch the state. */
  let refreshToken = 0;
  let stopEvents: (() => void) | null = null;

  function dedupe(ids: readonly string[]): string[] {
    return [...new Set(ids)];
  }

  function sameSelection(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((id, i) => id === b[i]);
  }

  /**
   * Expands the given anchors and merges their blocks into the working set
   * (accumulation: earlier content stays on the canvas). Over the working
   * set limit, least recently visited non-selected nodes are evicted.
   * `token` guards the state commit: only the latest expansion may touch
   * the state. `descendantDepth` is sent as-is: undefined means the
   * unbounded walk down (the cold-start seed).
   */
  async function expandInto(
    anchors: readonly string[],
    token: number,
    descendantDepth: number | undefined,
  ): Promise<void> {
    state.loading = true;
    try {
      let truncated = false;
      const groups = await client.queryExpand(anchors, {
        descendantDepth,
        showSiblings: state.config.showSiblings,
        siblingLimit: state.config.siblingLimit,
        limit: state.config.workingSetLimit,
      });
      const joined = new Set<string>(anchors);
      for (const group of groups) {
        if ("error" in group) continue;
        const expansion = group.results[0];
        if (expansion === undefined) continue;
        truncated ||= expansion.truncated;
        for (const node of expansion.nodes) {
          prime(node);
          joined.add(node.id);
        }
      }

      const map = new Map(workingSet.value);
      for (const id of joined) {
        const lite = liteCache.get(id);
        if (lite !== undefined) map.set(id, lite);
      }

      // Stamp this expansion and the selection as most recently visited,
      // then evict the oldest non-selected nodes down to the limit.
      const stamp = ++visitClock;
      for (const id of joined) lastVisited.set(id, stamp);
      const selected = new Set(anchors);
      const over = map.size - state.config.workingSetLimit;
      if (over > 0) {
        const lru = [...map.keys()]
          .filter((id) => !selected.has(id))
          .sort((a, b) => (lastVisited.get(a) ?? 0) - (lastVisited.get(b) ?? 0) || (a < b ? -1 : 1))
          .slice(0, over);
        for (const id of lru) {
          map.delete(id);
          lastVisited.delete(id);
        }
        truncated ||= lru.length > 0 || map.size > state.config.workingSetLimit;
      }

      if (token !== refreshToken) return;
      workingSet.value = map;
      state.truncated = truncated;
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

  /** Expands the current selection into the working set; an empty selection
   * keeps the canvas as it is (accumulation). */
  async function refresh(): Promise<void> {
    const token = ++refreshToken;
    const anchors = dedupe(state.selection);
    if (anchors.length === 0) {
      state.ready = true;
      return;
    }
    await expandInto(anchors, token, state.config.descendantDepth);
  }

  /**
   * Cold start: expand from the root constraints down to the working set
   * limit so the canvas opens on the whole inheritance structure instead of
   * an empty state (README, "数据：按需工作集"). Downstream depth is
   * unbounded here — the limit is the bound. Seed content is stamped as
   * least recently visited, so user exploration evicts it first. Best
   * effort: a failed seed leaves the canvas to selection-driven expansion.
   */
  async function seedFromRoots(): Promise<void> {
    try {
      const page = await client.search({ roots: true, limit: ROOT_SEED_LIMIT });
      const roots = page.nodes.map((node) => node.id);
      if (roots.length === 0) return;
      // Unbounded downstream: the working-set limit is the only bound.
      await expandInto(roots, ++refreshToken, undefined);
    } catch {
      // The user's first selection re-expands anyway.
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

  /** Shift click: replace the selection with the range between focus and
   * the clicked node. */
  async function rangeSelect(lite: NodeLite): Promise<void> {
    prime(lite);
    const focusId = state.focusId;
    if (focusId === null) {
      select(lite);
      return;
    }
    try {
      const result = await client.queryRange(focusId, lite.id);
      for (const node of result.nodes) prime(node);
      if (result.mode === "disconnected") {
        // No common ancestor within the budget (definitively unrelated, or
        // the budget ran out): the clicked node replaces the selection, per
        // design.
        setSelection([lite.id]);
        state.notice = "rangeDisconnected";
      } else {
        setSelection(result.nodes.map((node) => node.id));
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      return;
    }
    await refresh();
  }

  /** Ctrl click: toggle the node's membership in the selection. */
  function toggle(lite: NodeLite): void {
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

  /** Esc: clear the selection. The canvas keeps its accumulated content. */
  function clearSelection(): void {
    if (state.selection.length === 0) return;
    setSelection([]);
    state.hoveredId = null;
  }

  /** Hover: highlights the node and emphasizes its grounds edges. */
  function hover(id: string): void {
    state.hoveredId = id;
  }

  function unhover(): void {
    state.hoveredId = null;
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
    for (const id of deleted) {
      liteCache.delete(id);
      lastVisited.delete(id);
    }
    // Accumulation keeps stale entries alive unless dropped here: the next
    // refresh merges into the existing set instead of rebuilding it.
    if (workingSet.value.size > 0) {
      const map = new Map(workingSet.value);
      for (const id of deleted) map.delete(id);
      workingSet.value = map;
    }
    if (state.hoveredId !== null && deleted.has(state.hoveredId)) unhover();
    if (state.selection.some((id) => deleted.has(id))) {
      setSelection(state.selection.filter((id) => !deleted.has(id)));
    }
    void refresh();
  }

  async function refreshIssues(): Promise<void> {
    try {
      const result = await client.fetchIssues();
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
    // Accumulated nodes outside the selection get their lite shapes
    // refreshed so summaries and grounds never go stale.
    if (event.deleted.length > 0) pruneDeleted(event.deleted);
    else {
      void refresh();
      void refreshLites(event.changed);
    }
    void refreshIssues();
    for (const listener of changeListeners) {
      try {
        listener(event);
      } catch {
        // a broken listener must not break change application
      }
    }
  }

  /**
   * Pulls fresh lite shapes for changed nodes still on the canvas. Without
   * this, accumulated (unselected) nodes would keep stale summaries and
   * grounds until they happen to join an expansion again. Advisory: failures
   * leave the previous shapes in place.
   */
  async function refreshLites(ids: readonly string[]): Promise<void> {
    const present = ids.filter((id) => workingSet.value.has(id));
    if (present.length === 0) return;
    try {
      // A 0/0 neighborhood is a batched lite fetch: each id returns itself.
      const groups = await client.queryNeighbors(present, {
        ancestorDepth: 0,
        descendantDepth: 0,
      });
      let replaced = false;
      for (const group of groups) {
        if ("error" in group) continue;
        const neighborhood = group.results[0];
        if (neighborhood === undefined) continue;
        for (const node of neighborhood.nodes) {
          if (!workingSet.value.has(node.id)) continue;
          prime(node);
          replaced = true;
        }
      }
      if (replaced && workingSet.value.size > 0) {
        const map = new Map(workingSet.value);
        for (const id of present) {
          const lite = liteCache.get(id);
          if (lite !== undefined) map.set(id, lite);
        }
        workingSet.value = map;
      }
    } catch {
      // The next expansion refetches anyway.
    }
  }

  /** Subscribe to applied external-change events (SSE batches and reloads);
   * returns an unsubscribe function. */
  function onChange(callback: (event: ChangeEvent) => void): () => void {
    changeListeners.add(callback);
    return () => changeListeners.delete(callback);
  }

  /** Begin lifecycle: seed the canvas from the roots, subscribe to the
   * change feed and fetch issues. */
  function start(): void {
    if (stopEvents !== null) return;
    stopEvents = client.connectEvents(applyEvent, (connected) => {
      state.connected = connected;
    });
    void seedFromRoots();
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
      const event = await client.reloadGraph();
      applyEvent(event);
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    }
  }

  /** Config keys that only affect presentation; changing them re-renders
   * through the components' own watchers and needs no working-set refresh. */
  const VIEW_ONLY_CONFIG_KEYS: ReadonlySet<keyof CanvasConfig> = new Set([
    "budgetManual",
    "budgetMode",
    "textScale",
    "zoomAnchor",
    "zoomMax",
  ]);

  function setConfig(patch: Partial<CanvasConfig>): void {
    // Writes go through an unknown-valued view: a union key's write type is
    // the intersection of the property types, which is `never` here.
    const target = state.config as Record<keyof CanvasConfig, unknown>;
    let affectsWorkingSet = false;
    for (const key of Object.keys(patch) as Array<keyof CanvasConfig>) {
      const value = patch[key];
      if (value === undefined) continue;
      target[key] = value;
      writePreference(CONFIG_KEYS[key], String(value));
      if (!VIEW_ONLY_CONFIG_KEYS.has(key)) affectsWorkingSet = true;
    }
    if (affectsWorkingSet) void refresh();
  }

  /**
   * Nodes the canvas draws: the working set's constraints, plus its premises
   * when the facts layer is on (README, "显示规则与样式" — premises render
   * as weakened capsules). Edges come from the grounds of the displayed
   * constraints, restricted to grounds that are themselves displayed nodes.
   */
  const displayed = computed<NodeLite[]>(() => {
    const result: NodeLite[] = [];
    for (const node of workingSet.value.values()) {
      if (node.type === "constraint" || state.config.showPremises) result.push(node);
    }
    return result;
  });

  /** Lite shapes of the ordered selection, for the selection list UI. */
  const selectedNodes = computed<NodeLite[]>(() =>
    state.selection.map((id) => liteCache.get(id)).filter((n) => n !== undefined),
  );

  return {
    state: readonly(state),
    /** Working-set nodes the canvas displays, in stable order. */
    displayed,
    selectedNodes,
    start,
    stop,
    onChange,
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
}

export type Workspace = ReturnType<typeof createWorkspace>;

/** Provided by the embedding root (see main.ts); components inject it. */
export const workspaceKey: InjectionKey<Workspace> = Symbol("refino-workspace");
