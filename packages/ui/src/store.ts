import { reactive, readonly, watch } from "vue";
import {
  createNode as apiCreate,
  deleteNode as apiDelete,
  fetchNode,
  queryNeighbors,
  updateNode as apiUpdate,
} from "./api";
import { readPreference, writePreference } from "./preferences";
import { workspace } from "./workspace";
import type { IssueRecord, NodeLite, NodePayload, NodeRecord } from "./types";

/**
 * Global application UI state: theme, language, the detail window and the
 * node create/edit flows. Graph data is not held here — the on-demand
 * working set lives in `workspace.ts`; the detail window fetches the full
 * node it shows via GET /api/nodes/:id.
 */

export type Theme = "light" | "dark";
export type Locale = "zh" | "en";

interface DetailState {
  /** Id the detail data was loaded for. */
  id: string | null;
  loading: boolean;
  error: string | null;
  node: NodeRecord | null;
  /** Revision at fetch time; the basis for If-Match-style saves. */
  revision: number | null;
  issues: IssueRecord[];
  /** Direct dependents (constraints grounding this node). */
  dependents: NodeLite[];
}

interface State {
  detailOpen: boolean;
  /** null while creating a new node of the given type. */
  creatingType: "premise" | "constraint" | null;
  theme: Theme;
  locale: Locale;
  detail: DetailState;
}

const state = reactive<State>({
  detailOpen: false,
  creatingType: null,
  theme: readPreference<Theme>("refino.theme", "light"),
  locale: readPreference<Locale>("refino.locale", "zh"),
  detail: {
    id: null,
    loading: false,
    error: null,
    node: null,
    revision: null,
    issues: [],
    dependents: [],
  },
});

/** Detail reloads are asynchronous; only the latest request may fill the state. */
let detailToken = 0;

async function loadDetail(id: string): Promise<void> {
  const token = ++detailToken;
  state.detail = { ...emptyDetail(), id, loading: true };
  try {
    // Direct dependents = constraints whose grounds contain the node, i.e.
    // the first descendant hop of the neighborhood query (minus the node
    // itself, which comes back as its own depth-0 anchor).
    const [detail, dependentGroups] = await Promise.all([
      fetchNode(id),
      queryNeighbors([id], { ancestorDepth: 0, descendantDepth: 1 }),
    ]);
    if (token !== detailToken) return;
    const dependents = dependentGroups
      .filter((group): group is Extract<typeof group, { results: unknown[] }> => "results" in group)
      .flatMap((group) => group.results[0]?.nodes ?? [])
      .filter((node) => node.id !== id);
    state.detail = {
      id,
      loading: false,
      error: null,
      node: detail.node,
      revision: detail.revision,
      issues: detail.issues,
      dependents,
    };
  } catch (error) {
    if (token !== detailToken) return;
    state.detail = {
      ...emptyDetail(),
      id,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function emptyDetail(): DetailState {
  return {
    id: null,
    loading: false,
    error: null,
    node: null,
    revision: null,
    issues: [],
    dependents: [],
  };
}

// The detail window tracks the focus (last selected node) while open.
watch(
  () => [state.detailOpen, state.creatingType, workspace.state.focusId] as const,
  ([open, creating, focusId]) => {
    if (!open || creating !== null) return;
    if (focusId !== null) void loadDetail(focusId);
    else state.detail = emptyDetail();
  },
);

export const store = {
  state: readonly(state),
  /** Single click selects; the detail window opens on double click. */
  openDetail(): void {
    state.detailOpen = true;
  },
  /** Closing the window keeps the selection. */
  closeDetail(): void {
    state.detailOpen = false;
    state.creatingType = null;
  },
  startCreate(type: "premise" | "constraint"): void {
    state.creatingType = type;
    state.detailOpen = true;
  },
  cancelCreate(): void {
    state.creatingType = null;
    state.detailOpen = false;
  },

  async create(type: "premise" | "constraint", payload: NodePayload): Promise<string> {
    const { id } = await apiCreate(type, payload);
    state.creatingType = null;
    // Selecting the new node loads its detail via the focus watcher.
    const detail = await fetchNode(id);
    workspace.select({ id, type: detail.node.type, summary: detail.node.summary });
    return id;
  },

  async update(id: string, payload: NodePayload, revision?: number): Promise<void> {
    await apiUpdate(id, payload, revision);
    // The SSE feed also carries our own write; refresh here so the working
    // set follows even when the feed is unavailable.
    void workspace.refresh();
    if (state.detail.id === id) void loadDetail(id);
  },

  async remove(id: string): Promise<void> {
    await apiDelete(id);
    workspace.pruneDeleted([id]);
    if (state.detail.id === id) {
      state.detailOpen = false;
      state.detail = emptyDetail();
    }
  },

  setTheme(theme: Theme): void {
    state.theme = theme;
    writePreference("refino.theme", theme);
  },

  setLocale(locale: Locale): void {
    state.locale = locale;
    writePreference("refino.locale", locale);
  },
};
