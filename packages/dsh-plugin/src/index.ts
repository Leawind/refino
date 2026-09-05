import type { Context } from "@deepseek-ai/cordis";
// Side-effect type imports: declaration-merge the `agent/*` events and the
// `Agent` interface (with `inject` and `session.header.cwd`) onto the program.
import type {} from "@deepseek-ai/dsh-agent";
import type { Agent, SessionStartSource } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defaultAuthorizationContext } from "@refino/harness";
import { DeltaCoalescer } from "./coalesce.js";
import { createTools } from "./tools.js";
import {
  initialContextText,
  orientationText,
  updateText,
  REFINO_PLUGIN_SOURCE,
} from "./inject-text.js";
import { findRefinoDir } from "./locate.js";
import { RefinoWorkspace } from "./workspace.js";

/**
 * refino plugin for the DeepSeek Harness (docs/design.md, dsh 插件落地形态):
 * at session start it locates the `.refino` directory for the session cwd,
 * loads the CRG under the default authorization context, registers the
 * model-facing CRG tools on the agent scope, and injects the initial task
 * context as a durable plugin-sourced message. Graphs above the auto-anchor
 * budget get a minimal orientation instead of silence. External `.refino`
 * changes are watched and delivered as coalesced delta updates. Contexts
 * signed by the host (`RefinoWorkspace.signContext`) survive syncs; until
 * then the defaults apply.
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

  const get = () => workspaces.get(agent);
  for (const tool of createTools(get)) {
    agent.ctx.tools.register(tool);
  }

  // Fresh sessions get the initial context; resumes re-register the tools but
  // skip re-injection (the baseline is already in the session log). Sessions
  // above the auto-anchor budget get a minimal orientation so the model can
  // help the user sign anchors instead of working blind.
  if (source === "startup" || source === "clear") {
    const context = defaultAuthorizationContext(workspace.graph);
    if (context.complete) {
      inject(agent, initialContextText(workspace.graph, context.context));
    } else {
      inject(agent, orientationText(workspace.graph));
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
