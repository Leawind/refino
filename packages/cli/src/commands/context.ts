import {
  authorizationContextOf,
  convergeAuthorization,
  diffContext,
  estimateContext,
  renderContext,
} from "@refino/harness";
import type { Graph } from "refino";
import { Command } from "commander";
import {
  effectiveContext,
  resolveAuthorization,
  type ResolvedAuthorization,
} from "../authorization.js";
import { emit, withStore } from "../shared.js";
import type { GlobalOptions, RunFn } from "../shared.js";
import type { CliIo } from "../format.js";

const SOURCE_LABEL: Record<ResolvedAuthorization["source"], string> = {
  orchestrator: "凭据",
  workspace: "工作区签发",
  default: "默认",
};

interface ContextOptions {
  since?: string;
}

/**
 * `refino context` — render the effective authorization context as the
 * model-facing opening context (two-level injection, summary level). The
 * default source is derived live, so this command stays read-only unless a
 * signed workspace state exists. `--since <revision>` narrows the output to
 * what signing changed: it tracks signing revisions only — graph content
 * changes are picked up by re-querying.
 */
export function createContextCommand(io: CliIo, run: RunFn): Command {
  return new Command("context")
    .description("render the current authorization context (the task's opening context)")
    .option("--since <revision>", "only what signing changed since this revision")
    .action((_opts, cmd: Command) =>
      run(cmd, (opts: GlobalOptions) =>
        withStore(io, opts, (store) => {
          const o = cmd.opts() as ContextOptions;
          return renderContextOutput(io, opts, store.graph, o);
        }),
      ),
    );
}

async function renderContextOutput(
  io: CliIo,
  opts: GlobalOptions,
  graph: Graph,
  o: ContextOptions,
): Promise<number> {
  const resolved = await resolveAuthorization(graph, opts);
  const context = effectiveContext(resolved);

  if (o.since !== undefined) {
    const since = Number(o.since);
    if (!Number.isInteger(since) || since < 0) {
      io.stderr.write(`error: --since must be a non-negative integer, got "${o.since}"\n`);
      return 1;
    }
    if (since >= resolved.doc.revision) {
      if (opts.json) emit(io, { changed: false, revision: resolved.doc.revision });
      else {
        io.stdout.write(
          `授权上下文自 revision ${since} 以来未变化（当前 revision ${resolved.doc.revision}）。\n`,
        );
      }
      return 0;
    }
    const prevDoc = resolved.state?.history.find((d) => d.revision === since);
    if (prevDoc !== undefined) {
      const prev = authorizationContextOf(convergeAuthorization(graph, prevDoc));
      const delta = diffContext(graph, prev, context);
      if (opts.json) emit(io, { changed: true, revision: resolved.doc.revision, delta });
      else if (delta.length === 0) {
        io.stdout.write(`授权上下文自 revision ${since} 以来未变化。\n`);
      } else {
        io.stdout.write(
          `授权上下文增量（revision ${since} → ${resolved.doc.revision}）：\n${delta
            .map((event) => `- ${event.type} ${event.id}`)
            .join("\n")}\n（仅覆盖签发变化；图内容变化请重新运行 refino context 全量取用。）\n`,
        );
      }
      return 0;
    }
    // No signed snapshot at that revision (bounded history, or an
    // orchestrator credential): fall through to the full render.
    io.stdout.write(
      `（没有 revision ${since} 的签发快照，以下为全量上下文；当前 revision ${resolved.doc.revision}）\n\n`,
    );
  }

  const estimate = estimateContext(graph, context);
  if (opts.json) {
    emit(io, {
      revision: resolved.doc.revision,
      source: resolved.source,
      anchors: context.anchors,
      frozenFrontier: resolved.doc.frozenFrontier,
      estimate,
    });
    return 0;
  }
  const parts = [
    `# CRG 授权上下文（revision ${resolved.doc.revision}，来源：${SOURCE_LABEL[resolved.source]}）`,
    renderContext(graph, context),
  ];
  if (context.anchors.length === 0) {
    parts.push(
      "未设锚点：用 `refino search` 定位相关约束，经用户确认后以 `refino auth apply` 签发。",
    );
  }
  if (resolved.source === "default") {
    parts.push(
      "默认授权冻结全部根约束及其祖先；需调整时经用户同意后 `refino auth apply --dry-run` 预演签发。",
    );
  }
  parts.push(
    "`refino show <id>` 展开全文；`refino search <关键词>` 定位；`refino guide` 完整协议。",
  );
  io.stdout.write(`${parts.filter((p) => p.length > 0).join("\n\n")}\n`);
  return 0;
}
