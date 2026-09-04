import { reactive, readonly, watch } from "vue";
import {
  createNode as apiCreate,
  deleteNode as apiDelete,
  fetchNode,
  queryNeighbors,
  updateNode as apiUpdate,
} from "./api";
import { changedFields, mergeExternal, toEditorFields } from "./conflict";
import type { EditorField, EditorFields } from "./conflict";
import { readPreference, writePreference } from "./preferences";
import { workspace } from "./workspace";
import type { IssueRecord, NodeLite, NodePayload, NodeRecord } from "./types";

/**
 * Global application UI state: theme, language, the detail editor and the
 * node create/edit flows. Graph data is not held here — the on-demand
 * working set lives in `workspace.ts`; the detail editor fetches the full
 * node it shows via GET /api/nodes/:id and resolves external changes
 * against the user's edits (docs/design.md, "编辑冲突处理").
 */

export type Theme = "light" | "dark";
export type Locale = "zh" | "en";

/** The editable fields, owned by the store so external merges can update
 * the form while the editor keeps the user's edits. */
export interface DetailFormState {
  summary: string;
  body: string;
  rationale: string;
  grounds: string[];
  confirmed: string;
}

const emptyForm = (): DetailFormState => ({
  summary: "",
  body: "",
  rationale: "",
  grounds: [],
  confirmed: "",
});

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
  /** Editor snapshot: the field values the form was last based on. */
  base: EditorFields | null;
  /** External version colliding with user edits, awaiting a decision. */
  conflict: {
    node: NodeRecord;
    revision: number;
    fields: EditorField[];
  } | null;
  /** The node was deleted externally while the form held unsaved edits. */
  deletedWithEdits: boolean;
  /** Incremented after external edits were silently merged into the form. */
  mergeNotice: number;
}

interface State {
  detailOpen: boolean;
  /** null while creating a new node of the given type. */
  creatingType: "premise" | "constraint" | null;
  theme: Theme;
  locale: Locale;
  detail: DetailState;
}

/** The writable editor form; the component binds its inputs to this. */
export const detailForm = reactive<DetailFormState>(emptyForm());

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
    base: null,
    conflict: null,
    deletedWithEdits: false,
    mergeNotice: 0,
  },
});

function emptyDetail(): DetailState {
  return {
    id: null,
    loading: false,
    error: null,
    node: null,
    revision: null,
    issues: [],
    dependents: [],
    base: null,
    conflict: null,
    deletedWithEdits: false,
    mergeNotice: 0,
  };
}

function setFormFrom(node: NodeRecord | null): void {
  detailForm.summary = node?.summary ?? "";
  detailForm.body = node?.body ?? "";
  detailForm.rationale = node?.rationale ?? "";
  detailForm.grounds = [...(node?.grounds ?? [])];
  detailForm.confirmed = node?.confirmed ?? "";
}

function setDetail(
  detail: DetailState,
  external: {
    node: NodeRecord;
    revision: number;
    issues: IssueRecord[];
    dependents: NodeLite[];
  },
): void {
  detail.loading = false;
  detail.node = external.node;
  detail.revision = external.revision;
  detail.issues = external.issues;
  detail.dependents = external.dependents;
  detail.base = toEditorFields(external.node);
  setFormFrom(external.node);
}

/** Detail reloads are asynchronous; only the latest request may fill the state. */
let detailToken = 0;
/** Bumped whenever the detail state is replaced, so in-flight requests from
 * a previous generation cannot write into the current one. */
let detailGeneration = 0;

async function loadDetail(id: string): Promise<void> {
  const token = ++detailToken;
  const generation = ++detailGeneration;
  state.detail = { ...emptyDetail(), id, loading: true };
  try {
    // Direct dependents = constraints whose grounds contain the node, i.e.
    // the first descendant hop of the neighborhood query (minus the node
    // itself, which comes back as its own depth-0 anchor).
    const [detail, dependentGroups] = await Promise.all([
      fetchNode(id),
      queryNeighbors([id], { ancestorDepth: 0, descendantDepth: 1 }),
    ]);
    if (token !== detailToken || generation !== detailGeneration) return;
    const dependents = dependentGroups
      .filter((group): group is Extract<typeof group, { results: unknown[] }> => "results" in group)
      .flatMap((group) => group.results[0]?.nodes ?? [])
      .filter((node) => node.id !== id);
    setDetail(state.detail, { ...detail, dependents });
  } catch (error) {
    if (token !== detailToken || generation !== detailGeneration) return;
    state.detail = {
      ...emptyDetail(),
      id,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * External change affecting the open detail node: silently adopt the
 * external version when the user has no edits, merge it field-by-field when
 * the edits do not collide, and surface a conflict decision otherwise
 * (docs/design.md, "编辑冲突处理"). A deletion with unsaved edits offers
 * recreating the same id.
 */
async function refreshExternalDetail(): Promise<void> {
  const id = state.detail.id;
  const generation = detailGeneration;
  if (id === null || !state.detailOpen || state.creatingType !== null || state.detail.loading) {
    return;
  }
  try {
    const [external, dependentGroups] = await Promise.all([
      fetchNode(id),
      queryNeighbors([id], { ancestorDepth: 0, descendantDepth: 1 }),
    ]);
    // The editor may have moved on while the fetch was in flight.
    if (generation !== detailGeneration || state.detail.id !== id || state.creatingType !== null) {
      return;
    }
    const dependents = dependentGroups
      .filter((group): group is Extract<typeof group, { results: unknown[] }> => "results" in group)
      .flatMap((group) => group.results[0]?.nodes ?? [])
      .filter((node) => node.id !== id);
    const base = state.detail.base ?? toEditorFields(external.node);
    const userEdited = changedFields(base, detailForm);
    if (userEdited.length === 0) {
      // No edits to protect: adopt the external version wholesale.
      setDetail(state.detail, { ...external, dependents });
      return;
    }
    const merge = mergeExternal(base, detailForm, toEditorFields(external.node));
    if (merge.conflicts.length === 0) {
      // Silent field-level merge: untouched fields adopt the external
      // values, the user's edits survive.
      const mergedNode: NodeRecord = { ...external.node, ...merge.merged };
      setDetail(state.detail, {
        node: mergedNode,
        revision: external.revision,
        issues: external.issues,
        dependents,
      });
      state.detail.mergeNotice++;
      return;
    }
    state.detail.conflict = {
      node: external.node,
      revision: external.revision,
      fields: merge.conflicts,
    };
  } catch {
    // The node is gone. Unsaved edits offer recreating it; without edits
    // the editor simply closes.
    if (
      changedFields(state.detail.base ?? toEditorFields(emptyFormNode()), detailForm).length > 0
    ) {
      state.detail.deletedWithEdits = true;
    } else {
      state.detailOpen = false;
      state.detail = emptyDetail();
      setFormFrom(null);
    }
  }
}

function emptyFormNode(): NodeRecord {
  return {
    id: "",
    type: "premise",
    file: "",
    summary: "",
    body: "",
  };
}

// The detail editor tracks the focus (last selected node) while open.
watch(
  () => [state.detailOpen, state.creatingType, workspace.state.focusId] as const,
  ([open, creating, focusId]) => {
    if (!open || creating !== null) return;
    if (focusId !== null && focusId !== state.detail.id) void loadDetail(focusId);
  },
);

// External changes touching the open node drive the conflict flow.
workspace.onChange((event) => {
  const id = state.detail.id;
  const touchesDetail =
    id !== null &&
    (event.reload === true || event.changed.includes(id) || event.deleted.includes(id));
  if (touchesDetail) void refreshExternalDetail();
});

export const store = {
  state: readonly(state),
  /** The editor form; inputs bind to it directly. */
  form: detailForm,
  /** Single click selects; the detail window opens on double click. When
   * `id` differs from the loaded one, the detail is (re)loaded fresh. */
  openDetail(id?: string): void {
    state.detailOpen = true;
    if (id !== undefined && id !== state.detail.id) void loadDetail(id);
  },
  /** Closing the window keeps the selection. */
  closeDetail(): void {
    state.detailOpen = false;
    state.creatingType = null;
  },
  startCreate(type: "premise" | "constraint"): void {
    state.creatingType = type;
    state.detailOpen = true;
    setFormFrom(null);
    // A new premise defaults its confirmation time to now (matches the CLI's
    // --now); the value stays editable.
    if (type === "premise") detailForm.confirmed = new Date().toISOString();
  },
  cancelCreate(): void {
    state.creatingType = null;
    state.detailOpen = false;
  },
  /** Discard the user's edits: restore the form from the loaded node. */
  resetDetailForm(): void {
    setFormFrom(state.detail.node);
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
    try {
      await apiUpdate(id, payload, revision);
    } catch (error) {
      // A 409 means the content changed externally since the form was
      // based on it: surface the error, then run the merge flow so the
      // user sees and resolves what arrived.
      void refreshExternalDetail();
      throw error;
    }
    const detail = state.detail;
    if (detail.id === id && detail.node !== null) {
      // The saved form is the new base; adopt the returned state locally
      // (the SSE feed also carries our own write and re-expands the set).
      const saved = await fetchNode(id);
      if (detail.id === id && state.detail.id === id) {
        setDetailContent(saved);
        detail.base = toEditorFields(saved.node);
        setFormFrom(saved.node);
      }
    }
    // Working-set refresh rides on the SSE feed; refresh() covers the
    // window where the feed is unavailable.
    void workspace.refresh();
  },

  async remove(id: string): Promise<void> {
    await apiDelete(id);
    workspace.pruneDeleted([id]);
    if (state.detail.id === id) {
      state.detailOpen = false;
      detailGeneration++;
      state.detail = emptyDetail();
      setFormFrom(null);
    }
  },

  /** Apply the pending external version (load external over local edits). */
  applyConflictExternal(): void {
    const conflict = state.detail.conflict;
    if (conflict === null) return;
    state.detail.node = conflict.node;
    state.detail.revision = conflict.revision;
    state.detail.base = toEditorFields(conflict.node);
    state.detail.conflict = null;
    setFormFrom(conflict.node);
  },

  /** Keep the local edits on top of the pending external version: the next
   * save carries the external revision and overwrites it. */
  keepLocalOverConflict(): void {
    const conflict = state.detail.conflict;
    if (conflict === null) return;
    state.detail.revision = conflict.revision;
    state.detail.base = toEditorFields(conflict.node);
    state.detail.conflict = null;
  },

  /** Discard the pending recreation prompt and close the editor. */
  discardDeletedWithEdits(): void {
    state.detail.deletedWithEdits = false;
    state.detailOpen = false;
    detailGeneration++;
    state.detail = emptyDetail();
    setFormFrom(null);
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

function setDetailContent(external: {
  node: NodeRecord;
  revision: number;
  issues: IssueRecord[];
}): void {
  state.detail.node = external.node;
  state.detail.revision = external.revision;
  state.detail.issues = external.issues;
}

/**
 * Recreate a node that was deleted externally, using the editor's content
 * under the same id (PUT to a free id creates it).
 */
export async function recreateDetail(
  type: "premise" | "constraint",
  payload: NodePayload,
): Promise<void> {
  const id = state.detail.id;
  if (id === null) return;
  await apiUpdate(id, { ...payload, type }, undefined);
  state.detail.deletedWithEdits = false;
  await loadDetail(id);
  state.detailOpen = true;
}
