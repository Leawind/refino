import type { Context } from "@deepseek-ai/cordis";
// Side-effect type imports: declaration-merge the `agent/*` events and the
// `Agent` interface (with `inject` and `session.header.cwd`) onto the program.
import type {} from "@deepseek-ai/dsh-agent";
import type { Agent, SessionStartSource } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { initialContextText, orientationText, toolRefs, updateText } from "@refino/harness";
import { DeltaCoalescer, RefinoWorkspace } from "@refino/harness/host";
import { findRefinoDir } from "@refino/storage";
import { createTools } from "./tools.js";

/**
 * refino plugin for the DeepSeek Harness: at session start it locates the `.refino`
 * directory for the session cwd, loads the DLG, registers the model-facing DLG
 * tools on the agent scope, and injects the initial task context as a durable
 * plugin-sourced message. Graphs above the auto-anchor budget get a minimal
 * orientation instead of silence. External `.refino` changes are watched and
 * delivered as coalesced delta updates; the plugin writes no state files anywhere.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = "refino";

/** Minimum spacing between external-change injections. */
const EXTERNAL_SYNC_INTERVAL_MS = 2000;

/** dsh tool names (`refino_show`); injected texts cite the same names. */
const TOOLS = toolRefs("refino_");

/**
 * The plugin's own injected-message source kind. dsh has no catch-all plugin
 * source: every producer declares its kind through module augmentation.
 */
declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    refino: { kind: "refino" };
  }
}

/** Stable source stamped on every injected message. */
const REFINO_PLUGIN_SOURCE = { kind: "refino" } as const;

export function apply(ctx: Context): void {
  const workspaces = new WeakMap<Agent, RefinoWorkspace>();
  const coalescers = new WeakMap<Agent, DeltaCoalescer>();

  // `agent/created` is a serial, awaited phase: finish loading the DLG and
  // registering its tools before the session's first step can run, otherwise
  // an eager first turn races the async workspace open and sees no tools.
  ctx.on("agent/created", async ({ agent, source }) => {
    try {
      await startSession(ctx, agent, source, workspaces, coalescers);
    } catch (error) {
      ctx.logger.warn("refino: session initialization failed: %o", error);
    }
    return undefined;
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

  // Identical-text guard over injected updates: the rendered update is a pure
  // function of known changes/delta/pending, so an identical text carries zero new
  // information (e.g. an mtime-only rewrite re-firing the same batch) and is
  // dropped.
  let lastUpdateText: string | undefined;
  const injectUpdate = (text: string | undefined): void => {
    if (text === undefined || text === lastUpdateText) return;
    lastUpdateText = text;
    inject(agent, text);
  };
  // Late-bound through the holder: the coalescer needs the workspace for
  // fire-time known-set diffs, and the workspace's sync listener needs the
  // coalescer. No event can interleave between open() resolving and the
  // holder assignment (no await in between).
  const sync: { coalescer?: DeltaCoalescer } = {};
  const workspace = await RefinoWorkspace.open(refinoDir, (outcome) =>
    sync.coalescer?.push(outcome),
  );
  sync.coalescer = new DeltaCoalescer(EXTERNAL_SYNC_INTERVAL_MS, {
    knownDiff: () => workspace.knownDiff(),
    emit: (delta, pending, known) => injectUpdate(updateText(delta, known, pending)),
  });
  workspaces.set(agent, workspace);
  coalescers.set(agent, sync.coalescer);
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

  // Fresh sessions get the initial context. Sessions above the auto-anchor
  // budget get a minimal orientation so the model can search instead of
  // working blind; resumes skip the baseline, which is already in the log.
  if (source === "startup" || source === "clear") {
    if (workspace.anchorsComplete) {
      inject(
        agent,
        initialContextText(
          workspace.graph,
          workspace.session.anchorIds,
          TOOLS,
          workspace.stale(Date.now()),
        ),
      );
    } else {
      inject(agent, orientationText(workspace.graph, TOOLS));
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
