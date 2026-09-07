import { dirname } from "node:path";
import type { RefinoStore } from "@refino/storage";
import { ackEntries, readLedger, recordAffected } from "../review-state.js";

/** One ledger entry served to review clients, joined with the live graph. */
export interface PendingEntry {
  id: string;
  type: string;
  summary: string;
  source: string;
  kind: "update" | "delete";
  addedAt: string;
}

/**
 * Web-layer state over the storage Store (docs/design.md, "服务端常驻索引
 * 架构"): the projection itself lives in `RefinoStore`; this adds only the
 * HTTP-facing policy — the review ledger. API write handlers record their
 * affected downstream through `recordAffected` (awaited, so the response
 * returns after the ledger write); external file events record best-effort
 * through the store's change feed — serialized on a chain that `pending()`
 * awaits, so reads never race an in-flight recording. The pending set
 * served to clients is the ledger itself: review obligations survive
 * reloads and service restarts, resolved only by POST /api/pending/ack.
 */
export class WebState {
  readonly store: RefinoStore;
  readonly root: string;
  #recording: Promise<void> = Promise.resolve();
  #unsubscribe: () => void;

  constructor(store: RefinoStore, refinoDir: string) {
    this.store = store;
    this.root = dirname(refinoDir);
    this.#unsubscribe = store.onChange((change) => {
      // API writes are recorded by their handlers; reloads carry no change
      // of their own and never clear the ledger.
      if (change.reload || change.origin === "api") return;
      if (change.affected.length === 0) return;
      const source = change.deleted[0] ?? change.changed[0] ?? "external";
      const kind = change.deleted.length > 0 ? "delete" : "update";
      this.#recording = this.#recording
        .then(async () => {
          await recordAffected(
            this.root,
            change.affected.map((id) => ({ id, source, kind })),
          );
        })
        .catch(() => undefined);
    });
  }

  /** Ledger entries pending review, converged against the live graph. */
  async pending(): Promise<PendingEntry[]> {
    await this.#recording;
    const ledger = await readLedger(this.root, this.store.graph);
    return ledger.pending.map((entry) => {
      const node = this.store.graph.nodes.get(entry.id);
      return {
        id: entry.id,
        type: node?.type ?? "unknown",
        summary: node?.summary ?? "",
        source: entry.source,
        kind: entry.kind,
        addedAt: entry.addedAt,
      };
    });
  }

  /**
   * Record an API write's affected downstream (docs/crg.md 1.6). The graph
   * write has already succeeded, so a ledger failure degrades to the
   * git-review path instead of failing the request.
   */
  async recordAffected(
    source: string,
    kind: "update" | "delete",
    affected: string[] | undefined,
  ): Promise<void> {
    if (affected === undefined || affected.length === 0) return;
    this.#recording = this.#recording
      .then(async () => {
        await recordAffected(
          this.root,
          affected.map((id) => ({ id, source, kind })),
        );
      })
      .catch(() => undefined);
    await this.#recording;
  }

  /** Acknowledge reviewed ids (a human action over the web UI). */
  async ack(ids: readonly string[]): Promise<void> {
    await ackEntries(this.root, ids);
  }

  /** Detach from the store (stop recording external changes). */
  close(): void {
    this.#unsubscribe();
  }
}
