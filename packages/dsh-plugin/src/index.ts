import type { Context } from "@deepseek-ai/cordis";
// Side-effect type imports: declaration-merge the `agent/*` events and the
// `Agent` interface (with `inject` and `session.header.cwd`) onto the program.
import type {} from "@deepseek-ai/dsh-agent";
import type { Agent, SessionStartSource } from "@deepseek-ai/dsh-agent";
import type { ApprovalOutcome } from "@deepseek-ai/dsh-user-approval";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
  authorizationContextOf,
  convergeAuthorization,
  defaultAuthorizationContext,
} from "@refino/harness";
import { orchestratorCredential, readAuthorizationDocument } from "@refino/harness/state";
import { DeltaCoalescer } from "./coalesce.js";
import {
  authorizationStatusText,
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
 * loads the CRG under the effective authorization context — an orchestrator
 * credential when the environment provides one, the derived defaults
 * otherwise — registers the model-facing CRG tools on the agent scope, and
 * injects the initial task context as a durable plugin-sourced message.
 * Graphs above the auto-anchor budget get a minimal orientation instead of
 * silence. External `.refino` changes are watched and delivered as coalesced
 * delta updates; dialogue signing lives in session memory only — the plugin
 * writes no state files anywhere.
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

  // Identical-text guard over injected updates (docs/design.md, delta 注入
  // 降噪): the rendered update is a pure function of changed/deleted/delta/
  // pending, so an identical text carries zero new information (e.g. an
  // mtime-only rewrite re-firing the same batch) and is dropped. Shared by
  // the external-sync and signing lanes so the two cannot duplicate either.
  let lastUpdateText: string | undefined;
  const injectUpdate = (text: string | undefined): void => {
    if (text === undefined || text === lastUpdateText) return;
    lastUpdateText = text;
    inject(agent, text);
  };
  const coalescer = new DeltaCoalescer(
    EXTERNAL_SYNC_INTERVAL_MS,
    (delta, changed, deleted, pending) => {
      injectUpdate(updateText(delta, changed, deleted, pending));
    },
  );
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

  // Resolve the effective authorization: an orchestrator credential when the
  // environment provides one, the derived defaults otherwise. There is no
  // persisted signing lane on the plugin side — in-session signings die with
  // the process, and resume re-states the effective status in one line.
  const origin: AuthorizationOrigin = { source: "default", signedAt: "" };
  const credential = orchestratorCredential({}, process.env);
  if (credential !== undefined) {
    try {
      const doc = convergeAuthorization(
        workspace.graph,
        await readAuthorizationDocument(credential),
      );
      // Adopt the credential as session state; its delta is irrelevant here —
      // the baseline injection below already reflects it.
      workspace.signContext(authorizationContextOf(workspace.graph, doc));
      origin.source = "orchestrator";
      origin.signedAt = doc.signedAt;
    } catch (error) {
      ctx.logger.warn("refino: orchestrator credential unreadable, using defaults: %o", error);
    }
  }

  const originRecord = { ...origin };
  const get = () => workspaces.get(agent);
  const signing = {
    get,
    requestApproval: (reason: string) => requestApproval(ctx, agent, reason),
    inject: injectUpdate,
    origin: () => originRecord,
    setOrigin: (next: AuthorizationOrigin) => Object.assign(originRecord, next),
  };
  for (const tool of createTools(get, signing)) {
    agent.ctx.tools.register(tool);
  }

  // Fresh sessions get the initial context; resumes skip the baseline (it is
  // already in the session log) but re-state the effective authorization, so
  // the model never acts on a signing that fell back with the old process.
  // Sessions above the auto-anchor budget get a minimal orientation so the
  // model can search instead of working blind.
  if (source === "startup" || source === "clear") {
    if (defaultAuthorizationContext(workspace.graph).complete) {
      inject(
        agent,
        initialContextText(workspace.graph, workspace.authorizationContext, originRecord),
      );
    } else {
      inject(agent, orientationText(workspace.graph));
    }
  } else if (source === "resume") {
    inject(agent, authorizationStatusText(originRecord));
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
