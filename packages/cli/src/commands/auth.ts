import {
  applyAuthorization,
  authorizationContextOf,
  estimateContext,
  frozenZone,
  HarnessError,
  materializeDefaultAuthorization,
  type ApplyPreview,
  type SignedAuthorization,
} from "@refino/harness";
import { orchestratorCredential } from "@refino/harness/state";
import type { Graph } from "refino";
import { Command } from "commander";
import {
  effectiveContext,
  HISTORY_LIMIT,
  idList,
  readWorkspaceState,
  removeWorkspaceState,
  renderPreview,
  resolveAuthorization,
  workspaceStatePath,
  writeCredentialFile,
  writeWorkspaceState,
  type WorkspaceState,
} from "../authorization.js";
import { emit, withStore } from "../shared.js";
import type { GlobalOptions, RunFn } from "../shared.js";
import type { CliIo } from "../format.js";

/**
 * `refino auth` — human-approved authorization signing, driven by the model
 * in conversation (docs/design.md, "通用接入形态"). There is no interactive
 * wizard on purpose: the model drafts, `--dry-run` previews, the human
 * approves in conversation (and through the harness's command approval
 * surface), then the model applies. Writing targets the workspace-scoped
 * state lane only (`.refino/state/`, git-ignored) — orchestrator credentials
 * are read-only, so an active credential makes apply/reset a refused no-op
 * instead of a silent one.
 */
export function createAuthCommand(io: CliIo, run: RunFn): Command {
  const auth = new Command("auth").description(
    "show, apply or reset the workspace's signed authorization",
  );

  auth
    .command("show")
    .description("show the signed document and the effective context it resolves to")
    .action((_opts, cmd: Command) =>
      run(cmd, (opts: GlobalOptions) =>
        withStore(io, opts, (store) => showAuthorization(io, opts, store.graph)),
      ),
    );

  auth
    .command("apply")
    .description("sign a new authorization document (human approval required)")
    .option(
      "--frozen-frontier <id>",
      "frozen frontier constraint id; repeat for the full new list",
      collect,
      [] as string[],
    )
    .option("--dry-run", "preview the signing without writing anything", false)
    .option(
      "--output <path>",
      "also write the signed document to this path as an orchestrator credential file",
    )
    .option(
      "--expect-revision <n>",
      "refuse unless the current revision matches (optimistic concurrency)",
    )
    .action((_opts, cmd: Command) =>
      run(cmd, (opts: GlobalOptions) =>
        withStore(io, opts, (store) =>
          applyAuthorizationCommand(io, opts, store.graph, cmd.opts() as ApplyOptions),
        ),
      ),
    );

  auth
    .command("reset")
    .description("remove the workspace signing and return to the default context")
    .action((_opts, cmd: Command) =>
      run(cmd, async (opts: GlobalOptions) => resetAuthorization(io, opts)),
    );

  return auth;
}

function collect(value: string, previous: string[]): string[] {
  // Repeatable flag, but also accept comma-separated ids in one flag.
  return [
    ...previous,
    ...value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  ];
}

interface ApplyOptions {
  frozenFrontier?: string[];
  dryRun?: boolean;
  expectRevision?: string;
  output?: string;
}

function currentRevision(state: WorkspaceState | undefined): number {
  return state?.current.revision ?? 0;
}

async function showAuthorization(io: CliIo, opts: GlobalOptions, graph: Graph): Promise<number> {
  const resolved = await resolveAuthorization(graph, opts);
  const context = effectiveContext(graph, resolved);
  const zone = frozenZone(graph, context);
  const droppedFrontier = resolved.signed.frozenFrontier.filter(
    (id) => !resolved.doc.frozenFrontier.includes(id),
  );
  if (opts.json) {
    emit(io, {
      source: resolved.source,
      statePath: resolved.statePath,
      signed: resolved.signed,
      effective: { anchors: context.anchors, frozenFrontier: resolved.doc.frozenFrontier },
      zone: {
        constraints: zone.filter((n) => n.type === "constraint").length,
        premises: zone.filter((n) => n.type === "premise").length,
      },
      ...(droppedFrontier.length > 0 && { dropped: { frozenFrontier: droppedFrontier } }),
    });
    return 0;
  }
  const credential = orchestratorCredential(opts);
  const origin =
    resolved.source === "orchestrator"
      ? `编排者凭据（${credential ?? "--authorization"}）`
      : resolved.source === "workspace"
        ? `工作区签发（${resolved.statePath}）`
        : "默认（未签发；全部根约束及其祖先被冻结）";
  const lines = [
    `授权来源：${origin}`,
    `revision：${resolved.doc.revision}（signedAt ${resolved.doc.signedAt}）`,
    `锚点（自动注入策略，非签发内容）：${idList(context.anchors)}`,
    `冻结 frontier：${idList(resolved.doc.frozenFrontier)}`,
    `生效冻结区：${zone.filter((n) => n.type === "constraint").length} 个约束、${zone.filter((n) => n.type === "premise").length} 个前提`,
  ];
  if (droppedFrontier.length > 0) {
    lines.push(`收敛：签发中的 ${droppedFrontier.join(", ")} 已不存在，读取时忽略。`);
  }
  lines.push("预演签发：refino auth apply --dry-run；恢复默认：refino auth reset。");
  io.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function applyAuthorizationCommand(
  io: CliIo,
  opts: GlobalOptions,
  graph: Graph,
  o: ApplyOptions,
): Promise<number> {
  const credential = orchestratorCredential(opts);
  if (credential !== undefined) {
    io.stderr.write(
      `error: authorization is provided by an orchestrator credential (${credential}); "auth apply" would not take effect\n`,
    );
    return 1;
  }
  const frozenFrontier = o.frozenFrontier ?? [];
  if (frozenFrontier.length === 0) {
    io.stderr.write("error: specify at least one --frozen-frontier\n");
    return 1;
  }
  const statePath = workspaceStatePath(opts.root);
  const state = await readWorkspaceState(statePath);
  const revision = currentRevision(state) + 1;
  if (o.expectRevision !== undefined) {
    const expected = Number(o.expectRevision);
    if (!Number.isInteger(expected) || expected < 0) {
      io.stderr.write(`error: --expect-revision must be a non-negative integer\n`);
      return 1;
    }
    if (expected !== currentRevision(state)) {
      io.stderr.write(
        `error: authorization revision conflict: expected ${expected} but current is ${currentRevision(state)} (re-run "refino auth show")\n`,
      );
      return 1;
    }
  }

  let doc: SignedAuthorization;
  let preview: ApplyPreview;
  try {
    const outcome = applyAuthorization(graph, { frozenFrontier }, { revision });
    doc = outcome.doc;
    preview = outcome.preview;
  } catch (error) {
    if (error instanceof HarnessError) {
      io.stderr.write(`error: ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  if (o.dryRun === true) {
    const estimate = estimateContext(graph, authorizationContextOf(graph, doc));
    if (opts.json) emit(io, { dryRun: true, nextRevision: revision, preview, estimate });
    else {
      io.stdout.write(
        [
          `预演（未写入）：revision 将为 ${revision}`,
          ...renderPreview(preview),
          `- 注入规模：${estimate.blocks} 个上下文块，约 ${estimate.chars} 字符`,
          `确认后去掉 --dry-run 重新运行以签发。`,
        ].join("\n"),
      );
      io.stdout.write("\n");
    }
    return 0;
  }

  await writeWorkspaceState(opts.root, {
    current: doc,
    history:
      state !== undefined
        ? [state.current, ...state.history].slice(0, HISTORY_LIMIT)
        : // First signing: seed the history with the implicit default so
          // "context --since 0" can diff the signing against what the model
          // saw before any signature existed.
          [materializeDefaultAuthorization(graph)],
  });
  // The credential channel produces documents for the orchestration lane; it
  // runs alongside the workspace-state write, never instead of it.
  if (o.output !== undefined) await writeCredentialFile(o.output, doc);
  if (opts.json)
    emit(io, {
      ok: true,
      revision,
      statePath,
      preview,
      ...(o.output !== undefined && { output: o.output }),
    });
  else {
    io.stdout.write(
      [
        `已签发 revision ${revision}（写入 ${statePath}）`,
        ...(o.output !== undefined ? [`凭据文件：${o.output}`] : []),
        ...renderPreview(preview),
      ].join("\n"),
    );
    io.stdout.write("\n");
  }
  return 0;
}

async function resetAuthorization(io: CliIo, opts: GlobalOptions): Promise<number> {
  const credential = orchestratorCredential(opts);
  if (credential !== undefined) {
    io.stderr.write(
      `error: authorization is provided by an orchestrator credential (${credential}); "auth reset" would not take effect\n`,
    );
    return 1;
  }
  const statePath = workspaceStatePath(opts.root);
  const removed = await removeWorkspaceState(statePath);
  if (opts.json) emit(io, { removed, statePath });
  else if (removed) {
    io.stdout.write(`已移除工作区签发（${statePath}）；恢复默认授权上下文。\n`);
  } else {
    io.stdout.write("无工作区签发，当前已是默认授权上下文。\n");
  }
  return 0;
}
