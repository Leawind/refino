import { computed, reactive, readonly } from "vue";
import type { InjectionKey } from "vue";
import type { RefinoClient } from "./api";
import type { Workspace } from "./workspace";
import type { SearchNode } from "./types";

/**
 * Review flow state (README, "审阅抽屉"): changes arriving over SSE
 * accumulate as entries since the drawer was last looked at, and the
 * server's review ledger (docs/crg.md 1.6) renders alongside them.
 * Acknowledgements persist in the workspace ledger via POST /api/pending/ack
 * — they survive reloads and are shared with the CLI's `refino review ack`.
 * The derived states never touch the graph.
 */

export interface ChangeEntry {
  id: string;
  revision: number;
  origin: "api" | "file" | undefined;
  deleted: boolean;
}

const MAX_ENTRIES = 200;

export function createReview(client: RefinoClient, workspace: Workspace) {
  const state = reactive({
    /** Drawer visibility. */
    open: false,
    /** Change entries since the last look, oldest first, deduped by id. */
    entries: [] as ChangeEntry[],
    /** Entries at or below this revision count as seen. */
    lastSeenRevision: 0,
    /** The server's review ledger, refreshed when the drawer opens or acks. */
    pending: [] as SearchNode[],
  });

  function record(
    id: string,
    deleted: boolean,
    origin: "api" | "file" | undefined,
    revision: number,
  ): void {
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
    // A change may have pulled new entries into the review ledger; keep an
    // open drawer current.
    if (state.open) void refreshPending();
  });

  /** Changes the user has not looked at yet. */
  const unseen = computed(() =>
    state.entries.filter((entry) => entry.revision > state.lastSeenRevision),
  );

  /** The server's review-ledger entries awaiting acknowledgement. */
  const pending = computed(() => state.pending);

  async function refreshPending(): Promise<void> {
    try {
      state.pending = (await client.fetchPending()).nodes;
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

  async function ack(id: string): Promise<void> {
    try {
      await client.ackPending([id]);
      await refreshPending();
    } catch {
      // Best-effort alongside the CLI; the entry simply stays pending.
    }
  }

  return {
    state: readonly(state),
    unseen,
    pending,
    openDrawer,
    closeDrawer,
    ack,
    refreshPending,
  };
}

export type Review = ReturnType<typeof createReview>;

/** Provided by the embedding root (see main.ts); components inject it. */
export const reviewKey: InjectionKey<Review> = Symbol("refino-review");
