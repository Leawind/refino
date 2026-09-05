import type { GraphNode } from "refino";
import type { RefinoStore } from "@refino/storage";

/**
 * Web-layer state over the storage Store (docs/design.md, "服务端常驻索引
 * 架构"): the projection itself lives in `RefinoStore`; this adds only the
 * HTTP-facing policy — the pending-review accumulation. Every id that
 * directly depended on a changed node since the last reload / service start
 * is kept here; deleted change targets contribute their pre-mutation
 * dependents (they arrive in the change's `affected`). A derived, in-memory
 * state — client acknowledgements live client-side.
 */
export class WebState {
  readonly store: RefinoStore;
  #pendingIds = new Set<string>();
  #unsubscribe: () => void;

  constructor(store: RefinoStore) {
    this.store = store;
    this.#unsubscribe = store.onChange((change) => {
      if (change.reload) {
        this.#pendingIds.clear();
        return;
      }
      for (const id of change.affected) this.#pendingIds.add(id);
    });
  }

  /** Constraints pending review since the last reload / service start, sorted by id. */
  pending(): GraphNode[] {
    return [...this.#pendingIds]
      .sort()
      .map((id) => this.store.graph.nodes.get(id))
      .filter((node) => node !== undefined);
  }

  /** Detach from the store (stop accumulating pending reviews). */
  close(): void {
    this.#unsubscribe();
  }
}
