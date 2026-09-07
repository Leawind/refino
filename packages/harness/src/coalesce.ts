import type { DeltaEvent } from "./types.js";
import type { RefinoNode } from "refino";
import type { SyncOutcome } from "./workspace.js";

/**
 * Trailing-edge throttle over external sync outcomes (docs/design.md, dsh
 * 插件落地形态“delta 注入降噪”): watcher batches arriving within the
 * interval merge into one injection instead of waking the model per batch.
 * Merging is plain concatenation — each outcome's delta is already the
 * correct increment against the context state at its own sync.
 */
export class DeltaCoalescer {
  #delta: DeltaEvent[] = [];
  #changed = new Set<string>();
  #deleted = new Set<string>();
  #pending = new Map<string, RefinoNode>();
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly intervalMs: number,
    private readonly emit: (
      delta: DeltaEvent[],
      changed: string[],
      deleted: string[],
      pending: RefinoNode[],
    ) => void,
  ) {}

  push(outcome: SyncOutcome): void {
    this.#delta.push(...outcome.delta);
    for (const id of outcome.changed) this.#changed.add(id);
    for (const id of outcome.deleted) this.#deleted.add(id);
    for (const node of outcome.pending) this.#pending.set(node.id, node);
    this.#timer ??= setTimeout(() => this.#fire(), this.intervalMs);
  }

  /** Drop buffered state and stop the timer (agent disposal). */
  dispose(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#delta = [];
    this.#changed.clear();
    this.#deleted.clear();
    this.#pending.clear();
  }

  #fire(): void {
    this.#timer = null;
    const delta = this.#delta;
    // A node changed and then deleted within one window reports as deleted only.
    const changed = [...this.#changed].filter((id) => !this.#deleted.has(id));
    const deleted = [...this.#deleted];
    const pending = [...this.#pending.values()];
    this.#delta = [];
    this.#changed.clear();
    this.#deleted.clear();
    this.#pending.clear();
    if (delta.length > 0 || changed.length > 0 || deleted.length > 0 || pending.length > 0) {
      this.emit(delta, changed, deleted, pending);
    }
  }
}
