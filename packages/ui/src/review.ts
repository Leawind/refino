import { computed, reactive, readonly } from "vue";
import type { InjectionKey } from "vue";
import type { RefinoClient } from "./api";
import type { Workspace } from "./workspace";
import type { SearchNode } from "./types";

/**
 * Review flow state (README, "审阅抽屉"): changes arriving over SSE
 * accumulate as entries since the drawer was last looked at, and the
 * server's pending-review set (docs/crg.md 1.6) renders alongside them.
 * Acknowledgements are client preferences keyed by the global revision the
 * node last changed at — a node that changes again re-pends automatically.
 * The derived states never touch the graph.
 */

export interface ChangeEntry {
  id: string;
  revision: number;
  origin: "api" | "file" | undefined;
  deleted: boolean;
}

const ACK_KEY = "refino.review.acked";
const MAX_ENTRIES = 200;

function loadAcked(): Record<string, number> {
  try {
    const raw = localStorage.getItem(ACK_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function createReview(client: RefinoClient, workspace: Workspace) {
  const state = reactive({
    /** Drawer visibility. */
    open: false,
    /** Change entries since the last look, oldest first, deduped by id. */
    entries: [] as ChangeEntry[],
    /** Entries at or below this revision count as seen. */
    lastSeenRevision: 0,
    /** The server's pending-review set, refreshed when the drawer opens. */
    pending: [] as SearchNode[],
    /** id -> global revision the node was last seen changing at. */
    changedAt: new Map<string, number>(),
    /** id -> global revision at which the user marked it reviewed. */
    acked: loadAcked() as Record<string, number>,
  });

  function record(
    id: string,
    deleted: boolean,
    origin: "api" | "file" | undefined,
    revision: number,
  ): void {
    state.changedAt.set(id, revision);
    const existing = state.entries.find((entry) => entry.id === id);
    if (existing !== undefined) {
      existing.revision = revision;
      existing.origin = origin;
      existing.deleted = deleted;
      state.entries.splice(state.entries.indexOf(existing), 1);
      state.entries.push(existing);
      return;
    }
    state.entries.push({ id, revision, origin, deleted });
    if (state.entries.length > MAX_ENTRIES)
      state.entries.splice(0, state.entries.length - MAX_ENTRIES);
  }

  workspace.onChange((event) => {
    // Wholesale refreshes carry no reviewable change of their own.
    if (event.reload === true) return;
    for (const id of event.changed) record(id, false, event.origin, event.revision);
    for (const id of event.deleted) record(id, true, event.origin, event.revision);
  });

  /** Changes the user has not looked at yet. */
  const unseen = computed(() =>
    state.entries.filter((entry) => entry.revision > state.lastSeenRevision),
  );

  /** Pending constraints not acknowledged since their last change. */
  const pendingVisible = computed(() =>
    state.pending.filter(
      (node) => (state.acked[node.id] ?? 0) < (state.changedAt.get(node.id) ?? 0),
    ),
  );

  function saveAcked(): void {
    try {
      localStorage.setItem(ACK_KEY, JSON.stringify(state.acked));
    } catch {
      // Preferences are best-effort.
    }
  }

  async function refreshPending(): Promise<void> {
    try {
      const result = await client.fetchPending();
      // Pending ids the client never saw change (page opened later) anchor
      // at the current revision so they can be acknowledged meaningfully.
      for (const node of result.nodes) {
        if (!state.changedAt.has(node.id)) state.changedAt.set(node.id, workspace.state.revision);
      }
      state.pending = result.nodes;
    } catch {
      // The pending queue is advisory; keep the previous one.
    }
  }

  function openDrawer(): void {
    state.open = true;
    state.lastSeenRevision = state.entries.at(-1)?.revision ?? workspace.state.revision;
    void refreshPending();
  }

  function closeDrawer(): void {
    state.open = false;
  }

  function ack(id: string): void {
    state.acked[id] = state.changedAt.get(id) ?? workspace.state.revision;
    saveAcked();
  }

  return {
    state: readonly(state),
    unseen,
    pendingVisible,
    openDrawer,
    closeDrawer,
    ack,
    refreshPending,
  };
}

export type Review = ReturnType<typeof createReview>;

/** Provided by the embedding root (see main.ts); components inject it. */
export const reviewKey: InjectionKey<Review> = Symbol("refino-review");
