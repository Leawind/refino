import { reactive, readonly, type InjectionKey } from "vue";
import type { RefinoClient } from "./api";
import { changedFields, mergeExternal, toEditorFields } from "./conflict";
import type { EditorField, EditorFields } from "./conflict";
import { readPreference, writePreference } from "./preferences";
import type { Workspace } from "./workspace";
import type { IssueRecord, NodeLite, NodePayload, NodeRecord } from "./types";
import type { Locale, Theme } from "./types";

/**
 * Global application UI state: theme, language, the detail editor and the node
 * create/edit flows. Graph data is not held here — the on-demand working set lives
 * in `workspace.ts`; the detail editor fetches the full node it shows via GET
 * /api/nodes/:id and resolves external changes against the user's edits.
 */

export type { Theme, Locale } from "./types";

/** The editable fields, owned by the store so external merges can update
 * the form while the editor keeps the user's edits. */
export interface DetailFormState {
  summary: string;
  body: string;
  rationale: string;
  grounds: string[];
  confirmed: string;
  /** Decision trial mark; the form always states it (false = settled). */
  exploring: boolean;
}

const emptyForm = (): DetailFormState => ({
  summary: "",
  body: "",
  rationale: "",
  grounds: [],
  confirmed: "",
  exploring: false,
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
  /** Direct dependents (decisions grounding this node). */
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

/** A session switch waiting for the user's decision on unsaved work. */
export type PendingEditor =
  | { kind: "open"; id?: string }
  | { kind: "create"; type: "premise" | "decision"; prefill?: Partial<DetailFormState> };

interface State {
  /**
   * The editor sheet is open in the right pane, pinned to `detail.id` (or
   * to a new node while `creatingType` is set). The sheet does not follow
   * the canvas focus: a single edit session, explicitly entered and
   * explicitly left.
   */
  editorOpen: boolean;
  /** null while editing an existing node. */
  creatingType: "premise" | "decision" | null;
  /** A requested session the current one must yield to (see PendingEditor). */
  pendingEditor: PendingEditor | null;
  theme: Theme;
  locale: Locale;
  detail: DetailState;
}

/**
 * One editor store over one workspace: the detail editor and create/edit flows,
 * including the external-change merge flow.
 */
export function createStore(client: RefinoClient, workspace: Workspace) {
  /** The writable editor form; the component binds its inputs to this. */
  const detailForm = reactive<DetailFormState>(emptyForm());

  const state = reactive<State>({
    editorOpen: false,
    creatingType: null,
    pendingEditor: null,
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
    // The wire carries epoch milliseconds; the form edits the RFC 3339 form.
    detailForm.confirmed =
      node?.confirmed === undefined ? "" : new Date(node.confirmed).toISOString();
    detailForm.exploring = node?.exploring === true;
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
      // Direct dependents = decisions whose grounds contain the node, i.e.
      // the first descendant hop of the neighborhood query (minus the node
      // itself, which comes back as its own depth-0 anchor).
      const [detail, dependentGroups] = await Promise.all([
        client.fetchNode(id),
        client.queryNeighbors([id], { ancestorDepth: 0, descendantDepth: 1 }),
      ]);
      if (token !== detailToken || generation !== detailGeneration) return;
      const dependents = dependentGroups
        .filter(
          (group): group is Extract<typeof group, { results: unknown[] }> => "results" in group,
        )
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
   * External change affecting the open detail node: silently adopt the external
   * version when the user has no edits, merge it field-by-field when the edits do
   * not collide, and surface a conflict decision otherwise. A deletion with unsaved
   * edits offers recreating the same id.
   */
  async function refreshExternalDetail(): Promise<void> {
    const id = state.detail.id;
    const generation = detailGeneration;
    // Only the open sheet has a session to merge into; the dossier is a
    // separate read-only view and never participates in editing.
    if (id === null || !state.editorOpen || state.creatingType !== null || state.detail.loading) {
      return;
    }
    try {
      const [external, dependentGroups] = await Promise.all([
        client.fetchNode(id),
        client.queryNeighbors([id], { ancestorDepth: 0, descendantDepth: 1 }),
      ]);
      // The editor may have moved on while the fetch was in flight.
      if (
        generation !== detailGeneration ||
        state.detail.id !== id ||
        state.creatingType !== null
      ) {
        return;
      }
      const dependents = dependentGroups
        .filter(
          (group): group is Extract<typeof group, { results: unknown[] }> => "results" in group,
        )
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
        // values, the user's edits survive. The base stays the version the
        // edits were based on, so the merged state still counts as unsaved
        // and the save stays enabled. The merged confirmed (an RFC 3339
        // form string) goes back to the wire's epoch-millisecond form.
        const confirmedMs = Date.parse(merge.merged.confirmed);
        const mergedNode: NodeRecord = {
          ...external.node,
          ...merge.merged,
          confirmed:
            merge.merged.confirmed === "" || Number.isNaN(confirmedMs) ? undefined : confirmedMs,
        };
        state.detail.node = mergedNode;
        state.detail.revision = external.revision;
        state.detail.issues = external.issues;
        state.detail.dependents = dependents;
        setFormFrom(mergedNode);
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
        state.editorOpen = false;
        state.detail = emptyDetail();
        setFormFrom(null);
      }
    }
  }

  function emptyFormNode(): NodeRecord {
    return {
      id: "",
      type: "premise",
      summary: "",
      body: "",
    };
  }

  // External changes touching the open node drive the conflict flow.
  workspace.onChange((event) => {
    const id = state.detail.id;
    const touchesDetail =
      id !== null &&
      (event.reload === true || event.changed.includes(id) || event.deleted.includes(id));
    if (touchesDetail) void refreshExternalDetail();
  });

  /**
   * The payload of the current session, in the wire's optionality: empty
   * summary/rationale/confirmed are omitted, grounds are always stated, and
   * a decision always states its trial mark (omitting it would settle it).
   */
  function payloadOf(kind: "premise" | "decision"): NodePayload {
    return {
      body: detailForm.body,
      summary: detailForm.summary.trim() === "" ? undefined : detailForm.summary.trim(),
      rationale: detailForm.rationale.trim() === "" ? undefined : detailForm.rationale.trim(),
      grounds: detailForm.grounds,
      exploring: kind === "decision" ? detailForm.exploring : undefined,
      confirmed: detailForm.confirmed.trim() === "" ? undefined : detailForm.confirmed.trim(),
    };
  }

  /** Unsaved edits against the loaded node. */
  function sessionDirty(): boolean {
    const node = state.detail.node;
    if (node === null) return false;
    return changedFields(state.detail.base ?? toEditorFields(node), detailForm).length > 0;
  }

  /** Whether leaving the session now would throw work away. */
  function sessionHasWork(): boolean {
    if (state.creatingType !== null) {
      return (
        detailForm.summary.trim() !== "" ||
        detailForm.body.trim() !== "" ||
        detailForm.rationale.trim() !== "" ||
        detailForm.grounds.length > 0
      );
    }
    return sessionDirty();
  }

  function closeEditor(): void {
    state.editorOpen = false;
    state.creatingType = null;
    state.pendingEditor = null;
    detailGeneration++;
    state.detail = emptyDetail();
    setFormFrom(null);
  }

  async function applySession(request: PendingEditor): Promise<void> {
    state.pendingEditor = null;
    if (request.kind === "create") {
      state.creatingType = request.type;
      state.editorOpen = true;
      detailGeneration++;
      state.detail = emptyDetail();
      setFormFrom(null);
      if (request.prefill !== undefined) Object.assign(detailForm, request.prefill);
      // A new premise defaults its confirmation time to now (matches the
      // CLI's --now); the value stays editable.
      if (request.type === "premise" && request.prefill?.confirmed === undefined) {
        detailForm.confirmed = new Date().toISOString();
      }
      return;
    }
    state.creatingType = null;
    state.editorOpen = true;
    if (request.id !== undefined) {
      // Taking the session over also makes the node the canvas focus, so the
      // map and the sheet agree once the switch is applied.
      workspace.locate(request.id);
      if (request.id !== state.detail.id) await loadDetail(request.id);
    }
  }

  /**
   * Enter an editing session. A session holding work is never replaced
   * silently: the request parks in `pendingEditor` and the sheet asks for a
   * save/discard decision (ui DESIGN.md, "编辑功能").
   */
  function requestSession(request: PendingEditor): void {
    if (state.editorOpen && sessionHasWork()) {
      state.pendingEditor = request;
      return;
    }
    void applySession(request);
  }

  async function create(type: "premise" | "decision", payload: NodePayload): Promise<string> {
    const { id } = await client.createNode(type, payload);
    state.creatingType = null;
    state.editorOpen = true;
    const detail = await client.fetchNode(id);
    workspace.select({ id, type: detail.node.type, summary: detail.node.summary });
    await loadDetail(id);
    return id;
  }

  async function update(id: string, payload: NodePayload, revision?: number): Promise<void> {
    try {
      await client.updateNode(id, payload, revision);
    } catch (error) {
      // A 409 means the content changed externally since the form was based
      // on it: surface the error, then run the merge flow so the user sees
      // and resolves what arrived.
      void refreshExternalDetail();
      throw error;
    }
    const detail = state.detail;
    if (detail.id === id && detail.node !== null) {
      // The saved form is the new base; adopt the returned state locally
      // (the SSE feed also carries our own write and re-expands the set).
      const saved = await client.fetchNode(id);
      if (detail.id === id && state.detail.id === id) {
        setDetailContent(saved);
        detail.base = toEditorFields(saved.node);
        setFormFrom(saved.node);
      }
    }
    // Working-set refresh rides on the SSE feed; refresh() covers the
    // window where the feed is unavailable.
    void workspace.refresh();
  }

  /** Save the current session as-is; no-op when nothing changed. */
  async function saveCurrent(): Promise<void> {
    const kind = state.detail.node?.type ?? state.creatingType;
    if (kind === null) return;
    if (state.creatingType !== null) {
      await create(state.creatingType, payloadOf(kind));
    } else if (state.detail.node !== null && sessionDirty()) {
      await update(state.detail.node.id, payloadOf(kind), state.detail.revision ?? undefined);
    }
  }

  /** Resolve a parked session switch with the user's decision. */
  async function resolvePending(action: "save" | "discard" | "cancel"): Promise<void> {
    const pending = state.pendingEditor;
    if (pending === null) return;
    if (action === "cancel") {
      state.pendingEditor = null;
      return;
    }
    if (action === "save") await saveCurrent();
    await applySession(pending);
  }

  return {
    state: readonly(state),
    /** The editor form; inputs bind to it directly. */
    form: detailForm,
    /** Whether the node's edit session holds unsaved changes. */
    isDirty(id: string): boolean {
      return state.detail.id === id && sessionDirty();
    },
    /** The session holds work that leaving would discard. */
    hasUnsavedWork: sessionHasWork,
    /** Enter the editor for a node (the focus is used when `id` is absent). */
    openEditor(id?: string): void {
      requestSession({ kind: "open", id });
    },
    /** Leave the editor, discarding the session. */
    closeEditor,
    /**
     * Open the create editor for the given type. `prefill` seeds the form
     * (e.g. a canvas "refine this decision" seeds the grounds).
     */
    startCreate(type: "premise" | "decision", prefill?: Partial<DetailFormState>): void {
      requestSession({ kind: "create", type, prefill });
    },
    cancelCreate: closeEditor,
    resolvePending,
    /** Discard the user's edits: restore the form from the loaded node. */
    resetDetailForm(): void {
      setFormFrom(state.detail.node);
    },

    create,
    update,
    saveCurrent,

    async remove(id: string): Promise<void> {
      await client.deleteNode(id);
      workspace.pruneDeleted([id]);
      if (state.detail.id === id) closeEditor();
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
      closeEditor();
    },

    setTheme(theme: Theme): void {
      state.theme = theme;
      writePreference("refino.theme", theme);
    },

    setLocale(locale: Locale): void {
      state.locale = locale;
      writePreference("refino.locale", locale);
    },

    /**
     * Recreate a node that was deleted externally, using the editor's content
     * under the same id (PUT to a free id creates it).
     */
    async recreateDetail(type: "premise" | "decision"): Promise<void> {
      const id = state.detail.id;
      if (id === null) return;
      await client.updateNode(id, { ...payloadOf(type), type }, undefined);
      state.detail.deletedWithEdits = false;
      await loadDetail(id);
      state.editorOpen = true;
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
}

export type Store = ReturnType<typeof createStore>;

/** Provided by the embedding root (see main.ts); components inject it. */
export const storeKey: InjectionKey<Store> = Symbol("refino-store");
