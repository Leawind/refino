import {
  defaultAuthorizationContext,
  initialContextText,
  orientationText,
  reminderFrame,
  toolRefs,
} from "@refino/harness";
import { resolveAuthorization } from "@refino/harness/host";
import { findRefinoDir, loadGraph } from "@refino/storage";
import { drainUpdate } from "./queue.js";
import { TOOLS } from "./tool-names.js";

/**
 * One-shot hook entrypoints for the cc plugin (docs/design.md, cc-plugin
 * 落地形态), launched by the host as `node dist/hook.js <command>` with the
 * hook payload on stdin (Claude Code hook input shape):
 *
 * - `session-start` — SessionStart: locate `.refino/` for the payload cwd;
 *   fresh sessions (startup/clear) get the baseline context (or the minimal
 *   orientation above the auto-anchor budget); resume/compact get a neutral
 *   one-liner deferring to the context tool, because this process cannot
 *   see in-session signings held by the MCP server's process.
 * - `sync` — UserPromptSubmit: drain the cross-process queue and inject the
 *   accumulated updates (external changes, signing deltas) as context.
 *
 * Fail-open by design: a failing hook logs to stderr and exits 0 — context
 * injection must never block the session. A workspace without `.refino/`
 * stays silent entirely (adoption contract: no `.refino`, no takeover).
 */

/** The slice of the hook payload this plugin reads. */
export interface HookPayload {
  cwd?: string;
  /** SessionStart source: startup | resume | clear | compact. */
  source?: string;
  /** The event that fired this hook; the output must echo it back. */
  hook_event_name?: string;
}

// Bare short-name citations: the host injects full tool names itself.
const REFS = toolRefs("");

/** Parse stdin as the hook payload; empty or malformed input yields `{}`. */
async function readPayload(): Promise<HookPayload> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  try {
    const parsed = JSON.parse(raw) as HookPayload;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Events this plugin answers with an injection. */
export type InjectableEvent = "SessionStart" | "UserPromptSubmit" | "PostToolUse";

/** The Claude Code hook-output frame: one additionalContext injection. */
export function emitHookOutput(event: InjectableEvent, text: string): string {
  return `${JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: text },
  })}\n`;
}

/**
 * The event name a sync output must carry: the host validates the echoed
 * `hookEventName` against the event that fired the hook and drops mismatches,
 * so the same `sync` command serves both UserPromptSubmit and PostToolUse
 * only by echoing the payload's own event name.
 */
export function syncEvent(payload: HookPayload): InjectableEvent {
  return payload.hook_event_name === "PostToolUse" ? "PostToolUse" : "UserPromptSubmit";
}

/** Resolve the working directory of the hooking session. */
function workingDir(payload: HookPayload): string {
  return (
    payload.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.env.ZCODE_PROJECT_DIR ?? process.cwd()
  );
}

export interface SessionStartOutcome {
  /** The text to inject; undefined when the repo has no `.refino/`. */
  text?: string;
  /** Non-fatal resolution warning (unreadable orchestrator credential). */
  warning?: unknown;
}

/**
 * Render the SessionStart injection for a payload (testable core of the
 * `session-start` command). Read-only: the graph is loaded without watchers
 * — the long-lived MCP server owns the watched projection.
 */
export async function sessionStart(
  payload: HookPayload,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SessionStartOutcome> {
  const refinoDir = await findRefinoDir(workingDir(payload));
  if (refinoDir === undefined) return {};
  const { graph } = await loadGraph(refinoDir);
  const resolved = await resolveAuthorization(graph, env);
  if (payload.source === "resume" || payload.source === "compact") {
    return { text: resumeStatusText(), warning: resolved.warning };
  }
  // startup | clear | unrecognized sources: a fresh baseline.
  if (defaultAuthorizationContext(graph).complete) {
    return {
      text: initialContextText(graph, resolved.context, REFS, resolved.origin),
      warning: resolved.warning,
    };
  }
  return { text: orientationText(graph, REFS), warning: resolved.warning };
}

/**
 * The resume/compact line is neutral about the effective context on purpose:
 * unlike the dsh form (plugin process dies with the session), this host's
 * MCP server may survive a resume holding an in-session signing, and this
 * one-shot process cannot tell. Pointing the model at the context tool is
 * correct in every case; acting on remembered grants is what must not happen.
 */
function resumeStatusText(): string {
  return reminderFrame(
    [
      "refino：会话已恢复。",
      `当前生效授权以 ${TOOLS.context} 工具查询结果为准，不要凭会话历史中的授权记忆行动。`,
      `需要调整冻结区时，先与用户商定划分，再经 ${REFS.requestAuthorization} 提议（须经用户批准）。`,
    ].join(""),
  );
}

/** Render the UserPromptSubmit injection: the drained queue, if any. */
export async function sync(payload: HookPayload): Promise<string | undefined> {
  const refinoDir = await findRefinoDir(workingDir(payload));
  if (refinoDir === undefined) return undefined;
  return drainUpdate(refinoDir);
}

async function main(): Promise<void> {
  const payload = await readPayload();
  if (command === "session-start") {
    const outcome = await sessionStart(payload);
    if (outcome.warning !== undefined) {
      process.stderr.write(`refino: orchestrator credential unreadable, using defaults\n`);
    }
    if (outcome.text !== undefined)
      process.stdout.write(emitHookOutput("SessionStart", outcome.text));
  } else if (command === "sync") {
    const text = await sync(payload);
    if (text !== undefined) process.stdout.write(emitHookOutput(syncEvent(payload), text));
  }
}

// Guarded dispatch: reading stdin only makes sense as a launched hook. When
// imported (tests), no subcommand matches and the module stays side-effect
// free — awaiting stdin here would hang the importer forever.
const command = process.argv[2];
if (command === "session-start" || command === "sync") {
  await main().catch((error: unknown) => {
    // Fail-open: log and leave the session untouched.
    process.stderr.write(
      `refino hook failed: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
  });
}
