import { Command } from "commander";
import { getDependents } from "refino";
import type { Graph, NodeWithDepth } from "refino";
import { nodeIdFromRelativeFile } from "@refino/storage";
import { emit, withStore } from "../shared.js";
import type { GlobalOptions, RunFn } from "../shared.js";
import type { CliIo } from "../format.js";
import { git, isGitUnavailable } from "../git.js";
import type { GitError } from "../git.js";

/**
 * `refino pending` — the pending-review set (docs/crg.md 1.6) derived from
 * git: nodes changed since a baseline, plus the downstream constraints their
 * change potentially invalidates. The path→id mapping is the storage layer's
 * (`nodeIdFromRelativeFile`), so the storage layout never leaks into the
 * command's contract. Deleted nodes have no file anymore but their dependents
 * still deserve review, so they participate through a graph scan.
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

  if (opts.json) {
    emit(io, {
      base,
      modified,
      pending: pending.map((entry) => ({
        id: entry.node.id,
        type: entry.node.type,
        summary: entry.node.summary,
        depth: entry.depth,
      })),
    });
    return 0;
  }

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
