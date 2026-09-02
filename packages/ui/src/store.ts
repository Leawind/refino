import { reactive, readonly } from "vue";
import { createNode, deleteNode, fetchGraph, updateNode } from "./api";
import type { GraphRecord, NodePayload, NodeRecord } from "./types";

/**
 * Global application state. The whole graph is held in memory (CRGs are
 * small) and re-fetched after each mutation; selection and UI preferences
 * live here too.
 */

export type Theme = "light" | "dark";
export type Locale = "zh" | "en";

interface State {
  loading: boolean;
  loadError: string | null;
  refinoDir: string;
  issues: GraphRecord["issues"];
  nodes: NodeRecord[];
  selectedId: string | null;
  /** Whether the floating detail window is shown. */
  detailOpen: boolean;
  /** null while creating a new node of the given type. */
  creatingType: "premise" | "constraint" | null;
  theme: Theme;
  locale: Locale;
}

function readPreference<T extends string>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : (value as T);
  } catch {
    return fallback;
  }
}

function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Preferences are best-effort; private browsing may deny access.
  }
}

const state = reactive<State>({
  loading: false,
  loadError: null,
  refinoDir: "",
  issues: [],
  nodes: [],
  selectedId: null,
  detailOpen: false,
  creatingType: null,
  theme: readPreference<Theme>("refino.theme", "light"),
  locale: readPreference<Locale>("refino.locale", "zh"),
});

async function reload(): Promise<void> {
  state.loading = true;
  state.loadError = null;
  try {
    const graph = await fetchGraph();
    state.refinoDir = graph.refinoDir;
    state.issues = graph.issues;
    state.nodes = graph.nodes;
    if (state.selectedId !== null && !graph.nodes.some((n) => n.id === state.selectedId)) {
      state.selectedId = null;
    }
  } catch (error) {
    state.loadError = error instanceof Error ? error.message : String(error);
  } finally {
    state.loading = false;
  }
}

export const store = {
  state: readonly(state),
  get selected(): NodeRecord | null {
    return state.nodes.find((n) => n.id === state.selectedId) ?? null;
  },
  select(id: string | null): void {
    state.selectedId = id;
    state.creatingType = null;
  },
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
    state.selectedId = null;
    state.detailOpen = true;
  },
  cancelCreate(): void {
    state.creatingType = null;
    state.detailOpen = false;
  },
  reload,

  async create(type: "premise" | "constraint", payload: NodePayload): Promise<string> {
    const { id } = await createNode(type, payload);
    await reload();
    state.selectedId = id;
    state.creatingType = null;
    return id;
  },

  async update(id: string, payload: NodePayload): Promise<void> {
    await updateNode(id, payload);
    await reload();
  },

  async remove(id: string): Promise<void> {
    await deleteNode(id);
    await reload();
    if (state.selectedId === id) {
      state.selectedId = null;
      state.detailOpen = false;
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
