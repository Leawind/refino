import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Graph } from "refino";
import {
  authorizationContextOf,
  convergeAuthorization,
  materializeDefaultAuthorization,
  parseSignedAuthorization,
} from "./authorization.js";
import type { AuthorizationContext } from "./types.js";
import type { SignedAuthorization } from "./authorization.js";

/**
 * The user-level authorization state lane (docs/design.md, "授权状态的作用域").
 * Signed contexts persist per workspace root so a signing survives the tool
 * that made it — `refino auth apply` and tool plugins such as the dsh plugin
 * share one lane, and tasks resume with the context a human actually signed.
 * Three origins resolve with decreasing precedence: an orchestrator
 * credential (`--authorization` path or the `REFINO_AUTHORIZATION`
 * environment variable), the tool-managed workspace state, and the
 * materialized default. The default is derived live on every invocation and
 * never persisted; the state file only ever exists because a human approved
 * a signing.
 *
 * Node-only by necessity (fs, crypto, os) and exported as the
 * `@refino/harness/state` subpath so the platform-agnostic main entry stays
 * browser-safe.
 */

/** Where the effective authorization came from. */
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

/** What a consumer tells the resolver about itself; both fields map to CLI flags. */
export interface AuthorizationRequest {
  /** Workspace root (the directory containing `.refino/`). */
  root: string;
  /** Explicit orchestrator credential path (CLI `--authorization`). */
  authorization?: string;
}

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

/** Explicit orchestrator credential, by request field or environment. */
export function orchestratorCredential(
  req: Pick<AuthorizationRequest, "authorization">,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return req.authorization ?? env.REFINO_AUTHORIZATION;
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
      `workspace authorization at ${statePath} is not valid JSON (${error instanceof Error ? error.message : String(error)}); remove the state file or run "refino auth reset" to recover`,
      { cause: error },
    );
  }
  if (typeof parsed !== "object" || parsed === null || !("current" in parsed)) {
    throw new Error(
      `workspace authorization at ${statePath} is malformed; remove the state file or run "refino auth reset" to recover`,
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

/**
 * Materialize a signed document as an orchestrator credential file
 * (`auth apply --output`, plugin signing for orchestration lanes): the
 * written file feeds back through `--authorization` / `REFINO_AUTHORIZATION`
 * into child processes, so an orchestrator can hand each task its signed
 * context without touching the conversation lane's workspace state
 * (docs/design.md, "授权状态的作用域").
 */
export async function writeCredentialFile(
  outputPath: string,
  doc: SignedAuthorization,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const tmp = `${outputPath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  await rename(tmp, outputPath);
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
  req: AuthorizationRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedAuthorization> {
  const credential = orchestratorCredential(req, env);
  if (credential !== undefined) {
    const signed = await readAuthorizationFile(credential, "authorization document");
    const doc = convergeAuthorization(graph, signed);
    return { signed, doc, source: "orchestrator" };
  }
  const statePath = workspaceStatePath(req.root, env);
  const state = await readWorkspaceState(statePath);
  if (state !== undefined) {
    const doc = convergeAuthorization(graph, state.current);
    return { signed: state.current, doc, source: "workspace", statePath, state };
  }
  const signed = materializeDefaultAuthorization(graph);
  return { signed, doc: signed, source: "default" };
}

/** The effective context a write-path boundary check or injection acts on. */
export function effectiveContext(
  graph: Graph,
  resolved: ResolvedAuthorization,
): AuthorizationContext {
  return authorizationContextOf(graph, resolved.doc);
}
