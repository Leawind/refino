import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";
import { drainUpdate, peekUpdate } from "../src/queue.js";

/**
 * Host-stub layer: end-to-end over the real built artifacts with a scripted
 * stand-in for the host — the same actions ZCode performs (spawn the hook
 * with a payload, speak MCP over stdio, change files externally), asserted
 * at the process boundary. Covers what the function-level tests cannot:
 * bundle integrity (esbuild output, node startup), the payload→stdout
 * contract of the hooks, the MCP protocol round trip, and the full delta
 * pipeline (watcher → coalescer → queue → sync) with real fs events.
 *
 * The whole file skips when dist/ is absent (plain `vitest run` on a fresh
 * clone); `pnpm check` builds first, so CI always exercises it.
 */

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const hookDist = join(pkgRoot, "dist", "hook.js");
const mcpDist = join(pkgRoot, "dist", "mcp.js");

const e2e = existsSync(hookDist) && existsSync(mcpDist) ? describe : describe.skip;

/** watcher debounce (500ms) + coalescer (2000ms) + arming retries margin. */
const DELTA_SETTLE_MS = 10000;

const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const root = cleanup.pop()!;
    await drainUpdate(join(root, ".refino")).catch(() => {});
    await removeRefino(root).catch(() => {});
  }
});

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Tests assert the default-authorization paths, and the fallback chain
  // (payload.cwd -> CLAUDE_PROJECT_DIR -> ZCODE_PROJECT_DIR -> cwd) must not
  // climb into a real .refino/ around the test machine (dsh DESIGN.md's
  // findRefinoDir pitfall applies here too — this session's own harness
  // exports ZCODE_PROJECT_DIR pointing at this repo).
  delete env.REFINO_AUTHORIZATION;
  delete env.REFINO_PROJECT_DIR;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.ZCODE_PROJECT_DIR;
  return env;
}

interface HookRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Do what the host does: spawn the hook, feed it a payload, read the output. */
function runHook(command: string, payload: unknown): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [hookDist, command], {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

/** Parse one hook output line the way the host does. */
function parseHookOutput(stdout: string): { hookEventName: string; additionalContext: string } {
  const parsed = JSON.parse(stdout.trim()) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  return parsed.hookSpecificOutput;
}

/** A minimal MCP stdio client: newline-delimited JSON-RPC, like the host's. */
class McpProc {
  #proc: ReturnType<typeof spawn>;
  #buf = "";
  #nextId = 0;
  #pending = new Map<number, (message: Record<string, unknown>) => void>();

  constructor(cwd: string) {
    this.#proc = spawn("node", [mcpDist], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv(),
    });
    this.#proc.stdout!.on("data", (chunk: Buffer) => {
      this.#buf += chunk;
      let index: number;
      while ((index = this.#buf.indexOf("\n")) >= 0) {
        const line = this.#buf.slice(0, index);
        this.#buf = this.#buf.slice(index + 1);
        if (line.trim() === "") continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        const id = message.id as number | undefined;
        if (id !== undefined && this.#pending.has(id)) {
          this.#pending.get(id)!(message);
          this.#pending.delete(id);
        }
      }
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const id = ++this.#nextId;
      this.#pending.set(id, resolve);
      this.#proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string): void {
    this.#proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.request("tools/call", { name, arguments: args });
    return response.result as Record<string, unknown>;
  }

  close(): void {
    this.#proc.kill();
  }

  /** Resolve when the process is fully gone (watchers released). */
  exited(): Promise<void> {
    return new Promise((resolve) => {
      if (this.#proc.exitCode !== null) resolve();
      else this.#proc.once("exit", () => resolve());
    });
  }
}

async function fixtureRoot(): Promise<string> {
  const root = await createRefino({
    "nodes/P1/PREMISE-premise.md": premise("P1PREMISE", "事实一"),
    "nodes/R1/ROOT-constraint.md": constraint("R1ROOT", undefined, "根约束"),
    "nodes/C1/CHILD-constraint.md": constraint("C1CHILD", ["R1ROOT", "P1PREMISE"], "子约束"),
    "nodes/C2/GRAND-constraint.md": constraint("C2GRAND", ["C1CHILD"], "孙约束"),
  });
  cleanup.push(root);
  return root;
}

e2e("hook session-start over dist", () => {
  it("emits the framed baseline for a fresh session over an adopted repo", async () => {
    const root = await fixtureRoot();
    const run = await runHook("session-start", {
      cwd: root,
      source: "startup",
      session_id: "s1",
    });
    expect(run.code).toBe(0);
    const output = parseHookOutput(run.stdout);
    expect(output.hookEventName).toBe("SessionStart");
    expect(output.additionalContext).toMatch(/^<system-reminder>\n/);
    expect(output.additionalContext).toContain("## 作用域锚点");
    expect(output.additionalContext).toContain("R1ROOT [constraint] [冻结] 根约束");
  });

  it("stays silent for a repo without .refino (adoption contract)", async () => {
    const bare = await mkdtemp(join(tmpdir(), "refino-e2e-bare-"));
    cleanup.push(bare);
    const run = await runHook("session-start", { cwd: bare, source: "startup" });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
  });

  it("tolerates malformed stdin as an empty payload: exit 0, no output", async () => {
    // A clean child cwd too: with no parseable payload the hook falls back to
    // its own working directory, which must not resolve to an adopted repo.
    const bare = await mkdtemp(join(tmpdir(), "refino-e2e-bare-"));
    cleanup.push(bare);
    const run = await new Promise<HookRun>((resolve, reject) => {
      const child = spawn("node", [hookDist, "session-start"], {
        cwd: bare,
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv(),
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
      child.stdin.write("this is not json");
      child.stdin.end();
    });
    // Malformed input is defensively parsed as an empty payload (not an
    // error): the run stays silent over an unadopted directory and exits 0.
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
  });
});

e2e("hook sync over dist", () => {
  it("echoes the firing event and drains the queue once", async () => {
    const { enqueueUpdate } = await import("../src/queue.js");
    const root = await fixtureRoot();
    await enqueueUpdate(
      join(root, ".refino"),
      "<system-reminder>\nCRG 上下文更新：\n- 变更: R1ROOT\n</system-reminder>",
    );
    const postToolUse = parseHookOutput(
      (
        await runHook("sync", {
          cwd: root,
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          session_id: "s1",
        })
      ).stdout,
    );
    expect(postToolUse.hookEventName).toBe("PostToolUse");
    expect(postToolUse.additionalContext).toContain("变更: R1ROOT");
    // First drainer wins: the next event point finds nothing pending.
    const next = await runHook("sync", { cwd: root, hook_event_name: "UserPromptSubmit" });
    expect(next.stdout).toBe("");
  });

  it("is silent when nothing is queued", async () => {
    const root = await fixtureRoot();
    const run = await runHook("sync", { cwd: root, hook_event_name: "UserPromptSubmit" });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
  });
});

e2e("MCP server over dist", () => {
  it("serves the protocol: initialize, list, call, structured errors", async () => {
    const root = await fixtureRoot();
    const server = new McpProc(root);
    try {
      const init = (await server.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "e2e", version: "0" },
      })) as { result: { serverInfo: { name: string } } };
      expect(init.result.serverInfo.name).toBe("refino");
      server.notify("notifications/initialized");

      const listed = (await server.request("tools/list", {})) as {
        result: { tools: Array<{ name: string }> };
      };
      expect(listed.result.tools).toHaveLength(14);
      expect(listed.result.tools.map((tool) => tool.name)).toContain("request_authorization");

      const shown = (await server.call("show", { ids: ["R1ROOT"] })) as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      expect(shown.isError).toBeUndefined();
      expect(shown.content[0]!.text).toContain("根约束，无依据");

      // Writes against the default frozen zone escalate as normal results.
      const frozen = (await server.call("update_node", { id: "R1ROOT", body: "x" })) as {
        content: Array<{ type: string; text: string }>;
      };
      expect(frozen.content[0]!.text).toContain("位于冻结区，只读");

      const unknown = (await server.call("no-such-tool", {})) as { isError?: boolean };
      expect(unknown.isError).toBe(true);
    } finally {
      server.close();
      await server.exited();
    }
  });
});

e2e("full delta pipeline over dist", () => {
  it("delivers an external file change to the next sync as injected context", async () => {
    const root = await fixtureRoot();
    const server = new McpProc(root);
    try {
      // Any tool call arms the lazily opened watched workspace; show delivers
      // P1PREMISE's body, so the external edit below becomes a known-set
      // content change instead of a silently-unseen body edit.
      await server.call("list", {});
      await server.call("show", { ids: ["P1PREMISE"] });
      // External edit outside the session, like a user's editor would do.
      await appendFile(join(root, ".refino/nodes/P1/PREMISE-premise.md"), "\n外部改动。\n");
      const refinoDir = join(root, ".refino");
      await vi.waitFor(
        async () => {
          expect(await peekUpdate(refinoDir)).toBeDefined();
        },
        { timeout: DELTA_SETTLE_MS, interval: 250 },
      );
    } finally {
      server.close();
      await server.exited();
    }

    const run = await runHook("sync", {
      cwd: root,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      session_id: "s1",
    });
    const output = parseHookOutput(run.stdout);
    expect(output.hookEventName).toBe("PostToolUse");
    // Known-set semantics: the model saw P1PREMISE's body via show, so the
    // body edit surfaces as a content flag (never the body text itself);
    // the pending line carries P1PREMISE's direct dependents — C1CHILD
    // grounds on it, while R1ROOT is a root constraint and must not appear.
    expect(output.additionalContext).toContain("- P1PREMISE 正文已更新");
    expect(output.additionalContext).not.toContain("事实一");
    expect(output.additionalContext).not.toContain("外部改动");
    expect(output.additionalContext).toContain("- 待审查");
    expect(output.additionalContext).toContain("C1CHILD");
    expect(output.additionalContext).not.toContain("R1ROOT");
  });
});
