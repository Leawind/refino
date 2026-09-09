import type { RefinoStore } from "@refino/storage";

/**
 * Web-layer state over the storage Store (docs/design.md, "服务端常驻索引
 * 架构"): the projection itself lives in `RefinoStore`, watched so that
 * external file events keep it fresh; this adds only the HTTP-facing
 * lifecycle — one store per server, released with it.
 */
export class WebState {
  readonly store: RefinoStore;

  constructor(store: RefinoStore) {
    this.store = store;
  }

  /** Release the store (its watcher keeps the event loop alive). */
  close(): void {
    this.store.close();
  }
}
