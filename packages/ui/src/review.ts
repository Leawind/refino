import { computed, reactive, readonly } from "vue";
import type { InjectionKey } from "vue";
import type { Workspace } from "./workspace";

/**
 * Review flow state: changes arriving over SSE accumulate as entries since
 * the drawer was last looked at. Purely client-side — the derived state
 * never touches the graph.
 */

export interface ChangeEntry {
  id: string;
  revision: number;
  origin: "api" | "file" | undefined;
  deleted: boolean;
}

const MAX_ENTRIES = 200;

export function createReview(workspace: Workspace) {
  const state = reactive({
    /** Drawer visibility. */
    open: false,
    /** Change entries since the last look, oldest first, deduped by id. */
    entries: [] as ChangeEntry[],
    /** Entries at or below this revision count as seen. */
    lastSeenRevision: 0,
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
  });

  /** Changes the user has not looked at yet. */
  const unseen = computed(() =>
    state.entries.filter((entry) => entry.revision > state.lastSeenRevision),
  );

  function openDrawer(): void {
    state.open = true;
    state.lastSeenRevision = state.entries.at(-1)?.revision ?? workspace.state.revision;
  }

  function closeDrawer(): void {
    state.open = false;
  }

  return {
    state: readonly(state),
    unseen,
    openDrawer,
    closeDrawer,
  };
}

export type Review = ReturnType<typeof createReview>;

/** Provided by the embedding root (see main.ts); components inject it. */
export const reviewKey: InjectionKey<Review> = Symbol("refino-review");
