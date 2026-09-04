import type { Context } from "@deepseek-ai/cordis";
// Side-effect type imports: declaration-merge the `agent/*` events and the
// `Agent` interface (with `inject` and `session.header.cwd`) onto the program.
import type {} from "@deepseek-ai/dsh-agent";
import type { Agent, SessionStartSource } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defaultAuthorizationContext } from "@refino/harness";
import { createTools } from "./tools.js";
import { initialContextText, updateText, REFINO_PLUGIN_SOURCE } from "./inject-text.js";
import { findRefinoDir } from "./locate.js";
import { RefinoWorkspace } from "./workspace.js";

/**
 * refino plugin for the DeepSeek Harness (docs/design.md, dsh 插件落地形态):
 * at session start it locates the `.refino` directory for the session cwd,
 * loads the CRG under the default authorization context, registers the
 * model-facing CRG tools on the agent scope, and injects the initial task
 * context as a durable plugin-sourced message. External `.refino` changes are
 * watched and delivered as delta updates. v1 signs authorization contexts
 * from defaults only — conversation-time anchor/frozen-zone signing is a
 * later host integration.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = "refino";

export function apply(ctx: Context): void {
  const workspaces = new WeakMap<Agent, RefinoWorkspace>();

  ctx.on("agent/session-start", ({ agent, source }) => {
    void startSession(ctx, agent, source, workspaces).catch((error: unknown) => {
      ctx.logger.warn("refino: session initialization failed: %o", error);
    });
  });

  ctx.on("agent/disposed", ({ agent }) => {
    workspaces.get(agent)?.dispose();
    workspaces.delete(agent);
  });
}

async function startSession(
  ctx: Context,
  agent: Agent,
  source: SessionStartSource,
  workspaces: WeakMap<Agent, RefinoWorkspace>,
): Promise<void> {
  const cwd = agent.session.header.cwd ?? process.cwd();
  const refinoDir = await findRefinoDir(cwd);
  if (refinoDir === undefined) return;

  const workspace = await RefinoWorkspace.open(refinoDir, (outcome) => {
    inject(agent, updateText(outcome.delta, outcome.pending));
  });
  workspaces.set(agent, workspace);
  if (workspace.issues.length > 0) {
    ctx.logger.warn(
      "refino: graph loaded with %d issue(s) for %s",
      workspace.issues.length,
      refinoDir,
    );
  }

  const get = () => workspaces.get(agent);
  for (const tool of createTools(get)) {
    agent.ctx.tools.register(tool);
  }

  // Fresh sessions get the initial context; resumes re-register the tools but
  // skip re-injection (the baseline is already in the session log). Sessions
  // above the auto-anchor budget stay tool-only until anchors are signed.
  if (source === "startup" || source === "clear") {
    const context = defaultAuthorizationContext(workspace.graph);
    if (context.complete) {
      inject(agent, initialContextText(workspace.graph, context.context));
    }
  }
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
