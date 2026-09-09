import { Command } from "commander";
import { getDependents } from "refino";
import type { Graph, NodeWithDepth } from "refino";
import { nodeIdFromRelativeFile } from "@refino/storage";
import { withStore } from "../shared.js";
import type { GlobalOptions, RunFn } from "../shared.js";
import type { CliIo } from "../format.js";
import { readLedger } from "../review-state.js";
import { git, isGitUnavailable } from "../git.js";
import type { GitError } from "../git.js";

/**
 * `refino pending` — the pending-review set (docs/crg.md 1.6) from two
 * sources: nodes changed since a git baseline plus the downstream constraints
 * their change potentially invalidates, and the workspace review ledger —
 * obligations recorded by write commands that survive the commit landing the
 * change, resolved only by `refino review ack`. The path→id mapping is the
 * storage layer's (`nodeIdFromRelativeFile`), so the storage layout never
 * leaks into the command's contract. Deleted nodes have no file anymore but
 * their dependents still deserve review, so they participate through a graph
 * scan.
 */
export function createPendingCommand(io: CliIo, run: RunFn): Command {
  return new Command("pending")
    .description(
      "nodes changed since a git baseline and their downstream pending-review constraints",
    )
    .option(
      "--base <git-ref>",
      "baseline to diff against (default: HEAD, i.e. uncommitted changes)",
    )
    .action((_opts, cmd: Command) =>
      run(cmd, (opts: GlobalOptions) =>
        withStore(io, opts, (store) => pendingCommand(io, cmd.opts(), opts, store.graph)),
      ),
    );
}

interface PendingOptions {
  base?: string;
}

async function pendingCommand(
  io: CliIo,
  o: PendingOptions,
  opts: GlobalOptions,
  graph: Graph,
): Promise<number> {
  const base = o.base ?? "HEAD";
  let files: string[];
  try {
    files = await changedNodeFiles(opts.root, o.base);
  } catch (error) {
    if (isGitError(error)) {
      io.stderr.write(
        error.code === "GIT_UNAVAILABLE"
          ? 'error: git is not available on PATH; combine "git diff --name-only" with "refino dependents" manually\n'
          : `error: ${error.root} is not inside a git work tree; combine "git diff --name-only" with "refino dependents" manually\n`,
      );
      return 1;
    }
    throw error;
  }

  const modified = [...new Set(files.map(nodeIdFromRelativeFile).filter((id) => id !== undefined))]
    .sort()
    .map((id) => id!);
  const pending = pendingClosure(graph, modified);
  const shownPending = new Set(pending.map((entry) => entry.node.id));
  const ledger = await readLedger(opts.root, graph);
  // Ledger entries are themselves the awaiting set (one hop downstream of a
  // past change); cascading further would pre-flag reviews that belong to the
  // reviewer's own future modifications. Output skips ids the git-derived
  // section already lists.
  const ledgerOnly = ledger.pending.filter((entry) => !shownPending.has(entry.id));

  const lines = [
    `基线：${base}`,
    `已修改节点（${modified.length} 个）：${modified.join(", ") || "无"}`,
  ];
  if (pending.length === 0) {
    lines.push("无待审查约束。");
  } else {
    lines.push("待审查约束（下游受影响，修改前应复核）：");
    for (const entry of pending) {
      lines.push(
        `- ${entry.node.id} [${entry.node.type}] depth ${entry.depth} ${entry.node.summary}`,
      );
    }
  }
  if (ledgerOnly.length > 0) {
    lines.push('台账待审查（变更已提交后仍待确认，经 "refino review ack" 清除）：');
    for (const entry of ledgerOnly) {
      lines.push(
        `- ${entry.id}（因 ${entry.source} ${entry.kind === "delete" ? "删除" : "更新"}于 ${entry.addedAt}）`,
      );
    }
  }
  io.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

/** Node files under `.refino/nodes/` changed or deleted since `base`. */
async function changedNodeFiles(root: string, base: string | undefined): Promise<string[]> {
  // Probe the work tree first: error codes from `git diff` are not reliable
  // for distinguishing "not a repo" from a bad ref across git versions.
  try {
    await git(root, ["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    if (!isGitUnavailable(error)) {
      const e: GitError = { code: "NOT_A_REPO", root };
      throw e;
    }
    throw error;
  }
  let baseRef = base;
  if (baseRef === undefined) {
    // Unborn HEAD (no commits yet): fall back to untracked node files.
    try {
      await git(root, ["rev-parse", "--verify", "HEAD"]);
      baseRef = "HEAD";
    } catch (error) {
      if (isGitUnavailable(error)) throw error;
      return untrackedNodeFiles(root);
    }
  }
  const strip = (file: string): string => file.replaceAll("\\", "/").replace(/^\.refino\//, "");
  const diff = async (filter: string): Promise<string[]> => {
    const out = await git(root, [
      "diff",
      "--name-only",
      `--diff-filter=${filter}`,
      baseRef!,
      "--",
      ".refino/nodes/",
    ]);
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(strip);
  };
  return [...(await diff("ACMR")), ...(await diff("D"))];
}

async function untrackedNodeFiles(root: string): Promise<string[]> {
  const out = await git(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    ".refino/nodes/",
  ]);
  return out
    .split("\n")
    .map((line) => line.trim().replaceAll("\\", "/"))
    .filter((line) => line.startsWith("nodes/"));
}

function isGitError(error: unknown): error is GitError {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as GitError).code === "GIT_UNAVAILABLE" || (error as GitError).code === "NOT_A_REPO")
  );
}

/**
 * Downstream constraints potentially invalidated by changing `modified`:
 * the union of each id's dependents closure. Ids whose node no longer exists
 * (deleted since the baseline) seed from the graph scan — constraints
 * grounding on a deleted id would be dangling and must be reviewed.
 */
function pendingClosure(graph: Graph, modified: string[]): NodeWithDepth[] {
  const byId = new Map<string, NodeWithDepth>();
  const absorb = (entries: NodeWithDepth[]): void => {
    for (const entry of entries) {
      const known = byId.get(entry.node.id);
      if (known === undefined || entry.depth < known.depth) byId.set(entry.node.id, entry);
    }
  };
  for (const id of modified) {
    if (graph.nodes.has(id)) {
      absorb(getDependents(graph, id));
      continue;
    }
    // Deleted node: constraints still grounding on it seed the closure.
    for (const orphan of graph.nodes.values()) {
      if (orphan.type !== "constraint" || !orphan.grounds.includes(id)) continue;
      absorb([{ node: orphan, depth: 0 }]);
      absorb(
        getDependents(graph, orphan.id).map((e) => ({
          node: e.node,
          depth: e.depth + 1,
        })),
      );
    }
  }
  return [...byId.values()]
    .filter((entry) => !modified.includes(entry.node.id))
    .sort((a, b) => (a.depth !== b.depth ? a.depth - b.depth : a.node.id < b.node.id ? -1 : 1));
}
