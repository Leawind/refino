import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  authorizationContextOf,
  convergeAuthorization,
  frozenFrontier,
  materializeDefaultAuthorization,
  parseSignedAuthorization,
  type ApplyPreview,
  type SignedAuthorization,
} from "@refino/harness";
import type { Graph } from "refino";
import { getAncestors } from "refino";
import type { AuthorizationContext, ModificationCheck } from "@refino/harness";
import type { CliIo } from "./format.js";
import type { GlobalOptions } from "./shared.js";

/**
 * Authorization resolution for the CLI (docs/design.md, "通用接入形态").
 * One signed-document schema, three origins with decreasing precedence:
 * an orchestrator credential (`--authorization` path or the
 * `REFINO_AUTHORIZATION` environment variable), the tool-managed workspace
 * state written by `refino auth apply`, and the materialized default. The
 * default is derived live on every invocation and never persisted; the state
 * file only ever exists because a human approved a signing.
 */

export type AuthorizationSource = "orchestrator" | "workspace" | "default";

export interface ResolvedAuthorization {
  /** The signed document as stored (pre-convergence). */
  signed: SignedAuthorization;
  /** Effective document: converged against the current graph. */
  doc: SignedAuthorization;
  source: AuthorizationSource;
  /** Workspace state file path; absent for orchestrator and default origins. */
  statePath?: string;
  /** Full workspace state; absent for orchestrator and default origins. */
  state?: WorkspaceState;
}

export interface WorkspaceState {
  current: SignedAuthorization;
  /** Previous signed versions, most recent first; bounded for --since deltas. */
  history: SignedAuthorization[];
}

export const HISTORY_LIMIT = 10;

/** Base directory for tool-managed state; overridable for tests and sandboxed hosts. */
export function refinoHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.REFINO_HOME ?? join(homedir(), ".refino");
}

/**
 * Per-workspace state file: `<home>/workspaces/<sha256 of canonical root>.json`.
 * The root is canonicalized through symlinks so one repository maps to one
 * state file no matter which path variant reaches it (docs/design.md,
 * "授权状态的作用域"); a nonexistent root falls back to the literal absolute
 * path — keying must not throw before the store reports the real problem.
 */
export function workspaceStatePath(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = createHash("sha256").update(canonicalRoot(root)).digest("hex").slice(0, 16);
  return join(refinoHome(env), "workspaces", `${key}.json`);
}

function canonicalRoot(root: string): string {
  try {
    return realpathSync(resolve(root));
  } catch {
    return resolve(root);
  }
}

/** Explicit orchestrator credential, by flag or environment. */
export function orchestratorPath(
  opts: GlobalOptions,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return opts.authorization ?? env.REFINO_AUTHORIZATION;
}

async function readAuthorizationFile(path: string, what: string): Promise<SignedAuthorization> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `cannot read ${what} at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  try {
    return parseSignedAuthorization(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `invalid ${what} at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export async function readWorkspaceState(statePath: string): Promise<WorkspaceState | undefined> {
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `cannot read workspace authorization at ${statePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `workspace authorization at ${statePath} is not valid JSON (${error instanceof Error ? error.message : String(error)}); run "refino auth reset" to recover`,
      { cause: error },
    );
  }
  if (typeof parsed !== "object" || parsed === null || !("current" in parsed)) {
    throw new Error(
      `workspace authorization at ${statePath} is malformed; run "refino auth reset" to recover`,
    );
  }
  const state = parsed as { current: unknown; history?: unknown };
  const current = parseSignedAuthorization(state.current);
  const history = Array.isArray(state.history)
    ? state.history.slice(0, HISTORY_LIMIT).map((entry) => parseSignedAuthorization(entry))
    : [];
  return { current, history };
}

/** Atomic write (temp file + rename), mirroring the storage layer's discipline. */
export async function writeWorkspaceState(statePath: string, state: WorkspaceState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  const tmp = `${statePath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, statePath);
}

export async function removeWorkspaceState(statePath: string): Promise<boolean> {
  try {
    await stat(statePath);
  } catch {
    return false;
  }
  await rm(statePath);
  return true;
}

/**
 * Resolve the effective authorization for a workspace against the given
 * graph. Orchestrator credentials and the workspace state are converged on
 * the way out (deleted nodes dropped, frontier re-minimalized); the default
 * is materialized from the live graph and needs no convergence.
 */
export async function resolveAuthorization(
  graph: Graph,
  opts: GlobalOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedAuthorization> {
  const credential = orchestratorPath(opts, env);
  if (credential !== undefined) {
    const signed = await readAuthorizationFile(credential, "authorization document");
    const doc = convergeAuthorization(graph, signed);
    return { signed, doc, source: "orchestrator" };
  }
  const statePath = workspaceStatePath(opts.root, env);
  const state = await readWorkspaceState(statePath);
  if (state !== undefined) {
    const doc = convergeAuthorization(graph, state.current);
    return { signed: state.current, doc, source: "workspace", statePath, state };
  }
  const signed = materializeDefaultAuthorization(graph);
  return { signed, doc: signed, source: "default" };
}

/** The effective context a write-path boundary check acts on. */
export function effectiveContext(resolved: ResolvedAuthorization): AuthorizationContext {
  return authorizationContextOf(resolved.doc);
}

/**
 * Which signed frontier constraints cover a frozen node: the node itself, or
 * a frontier node whose ancestor closure contains it. Drives the escalation
 * report's "blocking position" line.
 */
export function coveringFrontier(
  graph: Graph,
  resolved: ResolvedAuthorization,
  id: string,
): string[] {
  return frozenFrontier(graph, effectiveContext(resolved))
    .filter((node) => {
      if (node.id === id) return true;
      return getAncestors(graph, node.id).some((a) => a.node.id === id);
    })
    .map((node) => node.id);
}

/** Truncate an id list for prose output. */
export function idList(ids: readonly string[], max = 8): string {
  if (ids.length === 0) return "（无）";
  const head = ids.slice(0, max).join(", ");
  return ids.length > max ? `${head} …等 ${ids.length} 个` : head;
}

/**
 * Model-facing escalation report for a blocked modification (docs/crg.md
 * 3.4): what blocked, where the block comes from, what a change would affect,
 * and the two sanctioned ways forward. Emitted as normal stdout output —
 * being blocked is a structured outcome, not a crash.
 */
export function renderEscalation(
  graph: Graph,
  resolved: ResolvedAuthorization,
  check: ModificationCheck,
  io: CliIo,
  json: boolean,
): void {
  if (json) {
    io.stdout.write(
      `${JSON.stringify({
        ok: false,
        blocked: {
          id: check.id,
          coveringFrontier: coveringFrontier(graph, resolved, check.id),
          affected: check.report?.affected.map((a) => ({ id: a.node.id, depth: a.depth })) ?? [],
        },
      })}\n`,
    );
    return;
  }
  const affected = check.report?.affected ?? [];
  const lines = [
    `越界：节点 ${check.id} 位于冻结区，修改被拒绝。`,
    `- 阻挡位置：被冻结 frontier ${idList(coveringFrontier(graph, resolved, check.id))} 覆盖`,
    affected.length > 0
      ? `- 若修改生效将影响下游约束：${idList(affected.map((a) => a.node.id))}`
      : "- 若修改生效将影响下游约束：（无）",
    "修改空间以内无法完成时：",
    "1. 向用户说明阻挡原因，经用户同意后 `refino auth apply --dry-run` 预演并签发新冻结区；",
    "2. 或在修改空间以内调整方案。",
  ];
  io.stdout.write(`${lines.join("\n")}\n`);
}

/** Preview/summary lines shared by `auth apply` and its dry run. */
export function renderPreview(preview: ApplyPreview): string[] {
  const lines = [`- 冻结区：${preview.frozenConstraints} 个约束、${preview.frozenPremises} 个前提`];
  if (preview.redundantFrontier.length > 0) {
    lines.push(
      `- frontier 归约：移除冗余项 ${preview.redundantFrontier.join(", ")}（被其他 frontier 约束覆盖）`,
    );
  }
  if (preview.unfrozenRoots.length > 0) {
    lines.push(
      `- warning: 以下根约束将解冻，需要项目最高级别的授权确认：${preview.unfrozenRoots.join(", ")}`,
    );
  }
  return lines;
}
