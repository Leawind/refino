import type { Graph, RefinoNode } from "refino";
import { Command } from "commander";
import { emit, withStore } from "../shared.js";
import type { GlobalOptions, RunFn } from "../shared.js";
import { renderNodeTable } from "../format.js";
import type { CliIo } from "../format.js";
import { readLedger } from "../review-state.js";

/** Roots listed in the text overview before the command points at `search`. */
const ROOTS_LIMIT = 30;

/**
 * `refino context` — the model-facing opening view: a read-only overview of
 * the CRG (scale, root constraints, pending-review status, where to go
 * next). The generic form has no authorization semantics (docs/design.md,
 * "通用接入形态"): reads and writes are unguarded beyond grounds validation,
 * so orientation — not permission — is this command's whole job.
 */
export function createContextCommand(io: CliIo, run: RunFn): Command {
  return new Command("context")
    .description("render the project overview (the task's opening context)")
    .action((_opts, cmd: Command) =>
      run(cmd, async (opts: GlobalOptions) =>
        withStore(io, opts, async (store) => {
          await renderOverview(io, opts, store.graph);
          return 0;
        }),
      ),
    );
}

async function renderOverview(io: CliIo, opts: GlobalOptions, graph: Graph): Promise<void> {
  const counts = countNodes(graph);
  const roots = rootConstraints(graph);
  // Best-effort: a broken ledger must not break orientation — pending and
  // review surface the error properly, here it degrades to a warning.
  let pendingReview = 0;
  try {
    pendingReview = (await readLedger(opts.root, graph)).pending.length;
  } catch (error) {
    io.stderr.write(`warning: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  if (opts.json) {
    emit(io, {
      counts,
      pendingReview,
      roots: roots.map((node) => ({ id: node.id, type: node.type, summary: node.summary })),
    });
    return;
  }

  const parts = [`# CRG 概览`, `- 节点：${counts.constraints} 个约束、${counts.premises} 个前提`];
  parts.push(
    pendingReview > 0
      ? `- 待审查：审核台账 ${pendingReview} 项（\`refino pending\` 查看，\`refino review ack\` 确认）`
      : "- 待审查：无（`refino pending` 查看未提交变更的影响面）",
  );
  if (roots.length === 0) {
    parts.push("- 根约束：无（图为空或约束均未落根，`refino list` 查看全部节点）");
  } else {
    const shown = roots.slice(0, ROOTS_LIMIT);
    parts.push(`- 根约束（项目最高层决策，${roots.length} 个）：`);
    const table = renderNodeTable(shown.map((node) => ({ ...node, depth: undefined })));
    parts.push(table.replace(/^/gm, "  "));
    if (roots.length > shown.length) {
      parts.push(`  （仅列前 ${shown.length} 个；\`refino search --roots\` 查看全部）`);
    }
  }
  parts.push(
    "`refino show <id>` 展开全文；`refino search <关键词>` 定位；`refino guide` 完整协议。",
  );
  io.stdout.write(`${parts.join("\n")}\n`);
}

/** Root constraints: grounds-less, the entry points of the decision hierarchy. */
function rootConstraints(graph: Graph): RefinoNode[] {
  const roots: RefinoNode[] = [];
  for (const node of graph.nodes.values()) {
    if (node.type === "constraint" && node.grounds.length === 0) roots.push(node);
  }
  return roots.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function countNodes(graph: Graph): { premises: number; constraints: number } {
  const counts = { premises: 0, constraints: 0 };
  for (const node of graph.nodes.values()) {
    if (node.type === "premise") counts.premises++;
    else counts.constraints++;
  }
  return counts;
}
