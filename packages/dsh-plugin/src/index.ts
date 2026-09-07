import type { Context } from "@deepseek-ai/cordis";
// Side-effect type imports: declaration-merge the `agent/*` events and the
// `Agent` interface (with `inject` and `session.header.cwd`) onto the program.
import type {} from "@deepseek-ai/dsh-agent";
import type { Agent, SessionStartSource } from "@deepseek-ai/dsh-agent";
import type { ApprovalOutcome } from "@deepseek-ai/dsh-user-approval";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { authorizationContextOf, defaultAuthorizationContext } from "@refino/harness";
import { resolveAuthorization } from "@refino/harness/state";
import { DeltaCoalescer } from "./coalesce.js";
import {
  initialContextText,
  orientationText,
  updateText,
  REFINO_PLUGIN_SOURCE,
} from "./inject-text.js";
import { findRefinoDir } from "./locate.js";
import { createTools } from "./tools.js";
import type { AuthorizationOrigin } from "./signing.js";
import { RefinoWorkspace } from "./workspace.js";

/**
 * refino plugin for the DeepSeek Harness (docs/design.md, dsh 插件落地形态):
 * at session start it locates the `.refino` directory for the session cwd,
 * loads the CRG under the effective authorization context — the shared
 * user-level state lane (orchestrator credential, then signed workspace
 * state, then the defaults) — registers the model-facing CRG tools on the
 * agent scope, and injects the initial task context as a durable
 * plugin-sourced message. Graphs above the auto-anchor budget get a minimal
 * orientation instead of silence. External `.refino` changes are watched and
 * delivered as coalesced delta updates; dialogue signing persists through
 * the state lane and survives resume.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = "refino";

/** Minimum spacing between external-change injections (docs/design.md, delta 降噪). */
const EXTERNAL_SYNC_INTERVAL_MS = 2000;

export function apply(ctx: Context): void {
  const workspaces = new WeakMap<Agent, RefinoWorkspace>();
  const coalescers = new WeakMap<Agent, DeltaCoalescer>();

  ctx.on("agent/session-start", ({ agent, source }) => {
    void startSession(ctx, agent, source, workspaces, coalescers).catch((error: unknown) => {
      ctx.logger.warn("refino: session initialization failed: %o", error);
    });
  });

  ctx.on("agent/disposed", ({ agent }) => {
    coalescers.get(agent)?.dispose();
    coalescers.delete(agent);
    workspaces.get(agent)?.dispose();
    workspaces.delete(agent);
  });
}

async function startSession(
  ctx: Context,
  agent: Agent,
  source: SessionStartSource,
  workspaces: WeakMap<Agent, RefinoWorkspace>,
  coalescers: WeakMap<Agent, DeltaCoalescer>,
): Promise<void> {
  const cwd = agent.session.header.cwd ?? process.cwd();
  const refinoDir = await findRefinoDir(cwd);
  if (refinoDir === undefined) return;

  const coalescer = new DeltaCoalescer(EXTERNAL_SYNC_INTERVAL_MS, (delta, pending) => {
    inject(agent, updateText(delta, pending));
  });
  const workspace = await RefinoWorkspace.open(refinoDir, (outcome) => coalescer.push(outcome));
  workspaces.set(agent, workspace);
  coalescers.set(agent, coalescer);
  if (workspace.issues.length > 0) {
    ctx.logger.warn(
      "refino: graph loaded with %d issue(s) for %s",
      workspace.issues.length,
      refinoDir,
    );
  }

  // Resolve the effective authorization from the shared state lane; an
  // unreadable lane falls back to the defaults rather than blocking the
  // session (the write path still enforces whatever context ends up active).
  const origin: AuthorizationOrigin = { source: "default", revision: 0, signedAt: "" };
  try {
    const resolved = await resolveAuthorization(workspace.graph, {
      root: workspace.workspaceRoot,
    });
    origin.source = resolved.source;
    origin.revision = resolved.doc.revision;
    origin.signedAt = resolved.doc.signedAt;
    origin.statePath = resolved.statePath;
    if (resolved.source !== "default") {
      // Adopt the signed document as session state; its delta is irrelevant
      // here — the baseline injection below already reflects it.
      workspace.signContext(authorizationContextOf(workspace.graph, resolved.doc));
    }
  } catch (error) {
    ctx.logger.warn("refino: authorization state unreadable, using defaults: %o", error);
  }

  const originRecord = { ...origin };
  const get = () => workspaces.get(agent);
  const signing = {
    get,
    requestApproval: (reason: string) => requestApproval(ctx, agent, reason),
    inject: (text: string | undefined) => inject(agent, text),
    origin: () => originRecord,
    setOrigin: (next: AuthorizationOrigin) => Object.assign(originRecord, next),
  };
  for (const tool of createTools(get, signing)) {
    agent.ctx.tools.register(tool);
  }

  // Fresh sessions get the initial context; resumes re-register the tools but
  // skip re-injection (the baseline is already in the session log). Sessions
  // above the auto-anchor budget get a minimal orientation so the model can
  // search instead of working blind.
  if (source === "startup" || source === "clear") {
    if (defaultAuthorizationContext(workspace.graph).complete) {
      inject(
        agent,
        initialContextText(workspace.graph, workspace.authorizationContext, originRecord),
      );
    } else {
      inject(agent, orientationText(workspace.graph));
    }
  }
}

/**
 * The host's approval surface is the mechanical human-approval gate for
 * dialogue signing. Typing through `Partial<Context>`: the approval service
 * is declared required by its plugin, but the host may not have it installed
 * — fail closed to `"unavailable"` instead of throwing.
 */
async function requestApproval(
  ctx: Context,
  agent: Agent,
  reason: string,
): Promise<ApprovalOutcome> {
  const approval = (ctx as Partial<Pick<Context, "approval">>).approval;
  if (approval === undefined) return "unavailable";
  return approval.request({ agent, toolName: "refino_request_authorization", reason });
}

/** Queue one durable plugin-sourced message; disposed agents drop it silently. */
function inject(agent: Agent, text: string | undefined): void {
  if (text === undefined) return;
  try {
    agent.inject(
      createUserMessage({ content: [{ type: "text", text }], source: { ...REFINO_PLUGIN_SOURCE } }),
    );
  } catch {
    // The agent was disposed between the event and the injection; dropping the
    // message is the documented behavior for pending context on disposal.
  }
}
