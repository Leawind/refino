import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";
import { emitHookOutput, sessionStart, sync, syncEvent } from "../src/hook.js";
import { enqueueUpdate } from "../src/queue.js";

/**
 * Hook behavior over fixture workspaces: the session-start branches per
 * source, the adoption contract stays silent without `.refino/`, and the
 * sync command drains the queue as one UserPromptSubmit context.
 */

const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await removeRefino(cleanup.pop()!);
  }
  delete process.env.REFINO_AUTHORIZATION;
});

async function fixtureRoot(): Promise<string> {
  const root = await createRefino({
    "nodes/P1/PREMISE-premise.md": premise("P1PREMISE", "事实一"),
    "nodes/R1/ROOT-constraint.md": constraint("R1ROOT", undefined, "根约束"),
    "nodes/C1/CHILD-constraint.md": constraint("C1CHILD", ["R1ROOT", "P1PREMISE"], "子约束"),
  });
  cleanup.push(root);
  return root;
}

describe("session-start", () => {
  it("injects the baseline context for a fresh session", async () => {
    const root = await fixtureRoot();
    const outcome = await sessionStart({ cwd: root, source: "startup" });
    expect(outcome.text).toMatch(/^<system-reminder>\n/);
    expect(outcome.text).toContain("## 作用域锚点");
    expect(outcome.text).toContain("R1ROOT [constraint] [冻结] 根约束");
    expect(outcome.text).toContain("P1PREMISE");
    expect(outcome.text).toContain("mcp__refino__show");
    expect(outcome.text).toContain("授权：默认上下文（未签发）");
  });

  it("treats clear like a fresh session and defaults unknown sources to the baseline", async () => {
    const root = await fixtureRoot();
    for (const source of ["clear", "unknown"]) {
      const outcome = await sessionStart({ cwd: root, source });
      expect(outcome.text).toContain("## 作用域锚点");
    }
  });

  it("stays entirely silent for a repo without .refino (adoption contract)", async () => {
    const bare = await mkdtemp(join(tmpdir(), "refino-hook-bare-"));
    cleanup.push(bare);
    expect(await sessionStart({ cwd: bare, source: "startup" })).toEqual({});
  });

  it("walks up from a nested working directory", async () => {
    const root = await fixtureRoot();
    const outcome = await sessionStart({ cwd: join(root, "a", "b"), source: "startup" });
    expect(outcome.text).toContain("R1ROOT");
  });

  it("injects a neutral resume line deferring to the context tool", async () => {
    const root = await fixtureRoot();
    for (const source of ["resume", "compact"]) {
      const outcome = await sessionStart({ cwd: root, source });
      expect(outcome.text).toMatch(/^<system-reminder>\n/);
      expect(outcome.text).toContain("会话已恢复");
      expect(outcome.text).toContain("以 mcp__refino__context 查询结果为准");
      expect(outcome.text).not.toContain("当前授权为默认上下文");
    }
  });

  it("renders the orchestrator ownership line when a credential is active", async () => {
    const root = await fixtureRoot();
    const cred = join(tmpdir(), `refino-hook-cred-${Date.now()}.json`);
    await writeFile(
      cred,
      JSON.stringify({
        version: 1,
        signedAt: "2026-09-08T00:00:00.000Z",
        revision: 1,
        frozenFrontier: ["R1ROOT"],
      }),
      "utf8",
    );
    cleanup.push(root);
    const outcome = await sessionStart(
      { cwd: root, source: "startup" },
      { REFINO_AUTHORIZATION: cred },
    );
    expect(outcome.warning).toBeUndefined();
    expect(outcome.text).toContain("编排者凭据（signedAt 2026-09-08T00:00:00.000Z");
    expect(outcome.text).toContain("任务内不可自我扩张");
  });

  it("falls back to defaults with a warning for an unreadable credential", async () => {
    const root = await fixtureRoot();
    const outcome = await sessionStart(
      { cwd: root, source: "startup" },
      { REFINO_AUTHORIZATION: "/nonexistent/credential.json" },
    );
    expect(outcome.warning).toBeDefined();
    expect(outcome.text).toContain("授权：默认上下文（未签发）");
  });
});

describe("sync", () => {
  it("drains queued updates for the session's project", async () => {
    const root = await fixtureRoot();
    await enqueueUpdate(join(root, ".refino"), "CRG 上下文更新：\n- 变更: R1ROOT");
    expect(await sync({ cwd: root })).toContain("变更: R1ROOT");
    expect(await sync({ cwd: root })).toBeUndefined(); // drained
  });

  it("stays silent without .refino or without queued updates", async () => {
    const bare = await mkdtemp(join(tmpdir(), "refino-sync-bare-"));
    cleanup.push(bare);
    expect(await sync({ cwd: bare })).toBeUndefined();
    const root = await fixtureRoot();
    expect(await sync({ cwd: root })).toBeUndefined();
  });
});

describe("emitHookOutput", () => {
  it("frames the Claude Code hook output shape", () => {
    const output = JSON.parse(emitHookOutput("SessionStart", "text"));
    expect(output).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "text" },
    });
    expect(JSON.parse(emitHookOutput("PostToolUse", "text")).hookSpecificOutput.hookEventName).toBe(
      "PostToolUse",
    );
  });

  it("echoes the firing event for sync outputs (the host drops mismatches)", () => {
    // The same sync command is mounted on both events; the output must carry
    // the event that actually fired or the host discards it.
    expect(syncEvent({ hook_event_name: "PostToolUse" })).toBe("PostToolUse");
    expect(syncEvent({ hook_event_name: "UserPromptSubmit" })).toBe("UserPromptSubmit");
    expect(syncEvent({})).toBe("UserPromptSubmit");
  });
});
