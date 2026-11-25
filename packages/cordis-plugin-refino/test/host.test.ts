import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import type { Agent, SessionStartSource } from "@deepseek-ai/dsh-agent";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { decision, createRefino, premise, removeRefino } from "@refino/testkit";
import { apply } from "../src/index.js";

/**
 * Host-level mounting tests: the real `apply(ctx)` on a real bare Cordis
 * `Context` (constructible with no arguments, built-in event bus and logger)
 * plus a hand-rolled fake `Agent` — no dsh runtime involved. What this buys
 * over the per-unit tests is the actual wiring: listener registration on
 * `agent/*` events, tool registration on the agent scope, injection text
 * selection per session source, watcher-driven coalesced deltas, and the
 * approval-surface fallback on a context that lacks the service.
 *
 * Most tests drive the flow through `ctx.emit`, which does not await
 * listeners, so assertions poll with `vi.waitFor` instead of awaiting a
 * handle; the ordering test below uses `ctx.serial` to model dsh's awaited
 * dispatch.
 */

/** watcher debounce (500ms) + delta coalescing (2s) — the longest quiet path. */
const SYNC_SETTLE_MS = 3000;

const mounted: Array<{ ctx: Context; agents: FakeAgent[] }> = [];
const cleanup: string[] = [];

afterEach(async () => {
  // Disposing agents first: the plugin closes each workspace's watcher on
  // `agent/disposed`, so fixture teardown never races a live fs watch.
  for (const { ctx, agents } of mounted) {
    for (const agent of agents) ctx.emit("agent/disposed", { agent: agent.agent });
  }
  mounted.length = 0;
  while (cleanup.length > 0) {
    await removeRefino(cleanup.pop()!);
  }
});

interface FakeAgent {
  agent: Agent;
  /** Tools the plugin registered on the agent scope, in order. */
  tools: ToolDefinition[];
  /** Text blocks of every message the plugin injected. */
  injected: string[];
}

/**
 * The exact slice of `Agent` the plugin touches: the session cwd, the
 * agent-scoped tool registry, and message injection. Structural typing keeps
 * this honest against the real interface at compile time, `as unknown as`
 * bridges the rest of the interface the plugin never reads.
 */
function fakeAgent(cwd: string): FakeAgent {
  const tools: ToolDefinition[] = [];
  const injected: string[] = [];
  const agent = {
    session: { header: { cwd } },
    ctx: { tools: { register: (tool: ToolDefinition) => void tools.push(tool) } },
    inject: (message: unknown) => {
      const content = (message as { content?: Array<{ type: string; text?: string }> }).content;
      if (Array.isArray(content)) {
        injected.push(
          ...content.filter((block) => block.type === "text").map((block) => block.text ?? ""),
        );
      }
    },
  };
  return { agent: agent as unknown as Agent, tools, injected };
}

/** Mount the plugin on a fresh real context and remember it for teardown. */
function mount(): Context {
  const ctx = new Context();
  apply(ctx);
  mounted.push({ ctx, agents: [] });
  return ctx;
}

/** Start a session for one fake agent and remember it for teardown. */
function startSession(ctx: Context, cwd: string, source: SessionStartSource): FakeAgent {
  const fake = fakeAgent(cwd);
  mounted.at(-1)!.agents.push(fake);
  ctx.emit("agent/created", { agent: fake.agent, source });
  return fake;
}

async function fixtureWorkspace(): Promise<string> {
  const root = await createRefino({
    "nodes/P1/PREMISE-premise.md": premise("P1PREMISE", "事实一"),
    "nodes/R1/ROOT-decision.md": decision("R1ROOT", undefined, "根决策"),
    "nodes/C1/CHILD-decision.md": decision("C1CHILD", ["R1ROOT", "P1PREMISE"], "子决策"),
  });
  cleanup.push(root);
  return root;
}

describe("plugin mounting on a real Cordis context", () => {
  it("finishes initialization within the awaited agent/created phase", async () => {
    // `agent/created` is serial and awaited before the session's first step:
    // an eager first turn must already see the tools and the initial context.
    // Polling here would hide exactly that race.
    const root = await fixtureWorkspace();
    const ctx = mount();
    const fake = fakeAgent(root);
    mounted.at(-1)!.agents.push(fake);

    await ctx.serial("agent/created", { agent: fake.agent, source: "startup" });

    expect(fake.tools).toHaveLength(13);
    expect(fake.injected.join("\n")).toContain("根决策");
  });

  it("registers the full toolset and injects the initial context on startup", async () => {
    const root = await fixtureWorkspace();
    const ctx = mount();
    const fake = startSession(ctx, root, "startup");

    await vi.waitFor(() => expect(fake.injected.length).toBeGreaterThan(0));
    // Registration order is an implementation detail; assert the exact set.
    expect(fake.tools.map((tool) => tool.name).sort()).toEqual(
      [
        "refino_search",
        "refino_siblings",
        "refino_list",
        "refino_show",
        "refino_grounds",
        "refino_ancestors",
        "refino_dependents",
        "refino_pending_review",
        "refino_stale",
        "refino_create_premise",
        "refino_create_decision",
        "refino_update_node",
        "refino_delete_node",
      ].sort(),
    );
    const initial = fake.injected.join("\n");
    expect(initial).toContain("<system-reminder>");
    // The default context injects the anchor summaries, not just a header.
    expect(initial).toContain("根决策");
    expect(initial).toContain("R1ROOT");
  });

  it("registers the tools but injects nothing on resume", async () => {
    const root = await fixtureWorkspace();
    const ctx = mount();
    const fake = startSession(ctx, root, "resume");

    await vi.waitFor(() => expect(fake.tools.length).toBe(13));
    // The baseline is already in the session log; nothing replays on resume.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fake.injected).toEqual([]);
  });

  it("stays silent when no .refino exists above the session cwd", async () => {
    // A clean temp directory, not process.cwd(): walking up from the repo
    // would find a real .refino in the developer's home directory.
    const bare = await mkdtemp(join(tmpdir(), "refino-no-mount-"));
    cleanup.push(bare);
    const ctx = mount();
    const fake = startSession(ctx, bare, "startup");

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fake.tools).toHaveLength(0);
    expect(fake.injected).toHaveLength(0);
  });

  it("injects a coalesced delta when a node file changes externally", async () => {
    const root = await fixtureWorkspace();
    const ctx = mount();
    const fake = startSession(ctx, root, "startup");
    await vi.waitFor(() => expect(fake.injected.length).toBeGreaterThan(0));
    fake.injected.length = 0;

    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(root, ".refino/nodes/P2"), { recursive: true });
    await writeFile(join(root, ".refino/nodes/P2/NEW-premise.md"), "新前提\n", "utf8");

    await vi.waitFor(() => expect(fake.injected.length).toBeGreaterThan(0), {
      timeout: SYNC_SETTLE_MS,
    });
    const text = fake.injected.join("\n");
    // The new node is unknown to the session: no field-level line for it and
    // the summary never rides along — only the anchor-membership delta.
    expect(text).toContain("- 新增作用域锚点: P2NEW");
    expect(text).not.toContain("新前提");
  });

  it(
    "drops an identical update re-fired by an mtime-only rewrite",
    { timeout: 15000 },
    async () => {
      const root = await fixtureWorkspace();
      const ctx = mount();
      const fake = startSession(ctx, root, "startup");
      await vi.waitFor(() => expect(fake.injected.length).toBeGreaterThan(0));
      fake.injected.length = 0;

      // The incident repro: a rewrite wave (e.g. a formatter) fires one batch,
      // then a second content-identical rewrite fires another beyond the
      // coalescing window. The known-set diff recognizes byte-identical
      // content (hash equal), so no field-level line fires — the pending
      // reminder is all the first batch injects; the second renders the
      // same text and drops.
      const { writeFile } = await import("node:fs/promises");
      const premisePath = join(root, ".refino/nodes/P1/PREMISE-premise.md");
      for (let i = 0; i < 2; i++) {
        await writeFile(premisePath, "事实一\n", "utf8");
        await new Promise((resolve) => setTimeout(resolve, SYNC_SETTLE_MS));
      }
      expect(fake.injected).toHaveLength(1);
      expect(fake.injected[0]).toContain("- 待审查");
      expect(fake.injected[0]).toContain("C1CHILD");
      expect(fake.injected[0]).not.toContain("正文已更新");
    },
  );

  it("stops syncing after the agent is disposed", async () => {
    const root = await fixtureWorkspace();
    const ctx = mount();
    const fake = startSession(ctx, root, "startup");
    await vi.waitFor(() => expect(fake.injected.length).toBeGreaterThan(0));
    fake.injected.length = 0;

    ctx.emit("agent/disposed", { agent: fake.agent });
    mounted.at(-1)!.agents.length = 0;

    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(root, ".refino/nodes/P3"), { recursive: true });
    await writeFile(join(root, ".refino/nodes/P3/GONE-premise.md"), "善后前提\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, SYNC_SETTLE_MS));
    expect(fake.injected).toHaveLength(0);
  });
});
