import type { KnownChange } from "./known-set.js";
import type { DeltaEvent } from "./types.js";
import type { RefinoNode } from "refino";
import type { SyncOutcome } from "./workspace.js";

/**
 * Trailing-edge throttle over external sync outcomes (docs/design.md, dsh
 * 插件落地形态“delta 注入降噪”): watcher batches arriving within the
 * interval merge into one injection instead of waking the model per batch.
 * The known-set diff is not buffered per outcome — it is taken at fire time
 * against the live graph, so tool results that interleaved with the window
 * have already refreshed the snapshots and collapse out of the notification
 * (docs/design.md, 会话已知集).
 */
export interface CoalescerDeps {
  /** Field-level known-set diff (draining) against the live workspace. */
  knownDiff: () => Promise<KnownChange[]>;
  emit: (delta: DeltaEvent[], pending: RefinoNode[], known: KnownChange[]) => void;
}

export class DeltaCoalescer {
  #delta: DeltaEvent[] = [];
  #pending = new Map<string, RefinoNode>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #deps: CoalescerDeps;

  constructor(
    readonly intervalMs: number,
    deps: CoalescerDeps,
  ) {
    this.#deps = deps;
  }

  push(outcome: SyncOutcome): void {
    this.#delta.push(...outcome.delta);
    for (const node of outcome.pending) this.#pending.set(node.id, node);
    this.#timer ??= setTimeout(() => void this.#fire(), this.intervalMs);
  }

  /** Drop buffered state and stop the timer (agent disposal). */
  dispose(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#delta = [];
    this.#pending.clear();
  }

  async #fire(): Promise<void> {
    this.#timer = null;
    const delta = this.#delta;
    const pending = [...this.#pending.values()];
    this.#delta = [];
    this.#pending.clear();
    const known = await this.#deps.knownDiff();
    if (delta.length > 0 || pending.length > 0 || known.length > 0) {
      this.#deps.emit(delta, pending, known);
    }
  }
}
