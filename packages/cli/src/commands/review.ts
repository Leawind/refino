import { Command } from "commander";
import { ackEntries, readLedger } from "../review-state.js";
import { emit, withStore, withStoreForWrite } from "../shared.js";
import type { GlobalOptions, RunFn } from "../shared.js";
import type { CliIo } from "../format.js";

const KIND_LABEL: Record<"update" | "delete", string> = {
  update: "更新",
  delete: "删除",
};

/**
 * `refino review` — the human side of the review workflow: list the ledger's
 * pending entries, or acknowledge them. Acknowledgement is a human action by
 * protocol (the skill's hard rules forbid the model from acking on the
 * user's behalf); the command itself enforces nothing — the ledger tracks
 * progress, it does not gate access.
 */
export function createReviewCommand(io: CliIo, run: RunFn): Command {
  const review = new Command("review")
    .description("the pending-review ledger: list entries, or acknowledge them (a human action)")
    .action((_opts, cmd: Command) =>
      run(cmd, (opts: GlobalOptions) =>
        withStore(io, opts, async (store) => {
          const ledger = await readLedger(opts.root, store.graph);
          if (opts.json) {
            emit(io, {
              pending: ledger.pending.map((entry) => ({
                ...entry,
                summary: store.graph.nodes.get(entry.id)?.summary,
              })),
            });
            return 0;
          }
          if (ledger.pending.length === 0) {
            io.stdout.write("审核台账为空：无待审查项。\n");
            return 0;
          }
          const lines = [
            `审核台账（${ledger.pending.length} 项待审查，确认经 "refino review ack"）：`,
          ];
          for (const entry of ledger.pending) {
            const node = store.graph.nodes.get(entry.id);
            const summary = node === undefined ? "" : ` ${node.summary}`;
            lines.push(
              `- ${entry.id} [${node?.type ?? "unknown"}]${summary}（因 ${entry.source} ${KIND_LABEL[entry.kind]}于 ${entry.addedAt}）`,
            );
          }
          io.stdout.write(`${lines.join("\n")}\n`);
          return 0;
        }),
      ),
    );

  review.addCommand(
    new Command("ack")
      .description("acknowledge reviewed entries, removing them from the ledger")
      .argument("[ids...]", "node ids to acknowledge")
      .option("--all", "acknowledge every pending entry instead of listing ids")
      .action((ids: string[], _opts, cmd: Command) =>
        run(cmd, (opts: GlobalOptions) => {
          const o = cmd.opts() as { all?: boolean };
          if (o.all === true && ids.length > 0) {
            io.stderr.write("error: ids and --all are mutually exclusive\n");
            return Promise.resolve(1);
          }
          return withStoreForWrite(io, opts, async (store) => {
            const ledger = await readLedger(opts.root, store.graph);
            const targets = o.all === true ? ledger.pending.map((entry) => entry.id) : ids;
            if (targets.length === 0) {
              io.stderr.write(
                "error: nothing to acknowledge (the ledger is empty or no ids given)\n",
              );
              return 1;
            }
            const missing = await ackEntries(opts.root, targets);
            const results = targets.map((id) =>
              missing.includes(id) ? { id, error: "not in the ledger" } : { id },
            );
            if (opts.json) emit(io, results);
            else {
              io.stdout.write(
                `${results
                  .map((r) =>
                    r.error === undefined ? `acked ${r.id}` : `error: ${r.error}: ${r.id}`,
                  )
                  .join("\n")}\n`,
              );
            }
            return missing.length > 0 ? 1 : 0;
          });
        }),
      ),
  );

  return review;
}
