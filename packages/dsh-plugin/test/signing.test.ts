import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { ApprovalOutcome } from "@deepseek-ai/dsh-user-approval";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";
import { readWorkspaceState, workspaceStatePath } from "@refino/harness/state";
import { createSigningTools, type AuthorizationOrigin, type SigningDeps } from "../src/signing.js";
import { RefinoWorkspace } from "../src/workspace.js";

/**
 * Dialogue signing against the shared user-level state lane: REFINO_HOME is
 * redirected into a temp dir so a signing never touches the real home, and
 * the approval surface is a stub resolving a canned outcome.
 */

const cleanup: string[] = [];
const workspaces: RefinoWorkspace[] = [];
let home = "";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "refino-sign-home-"));
  process.env.REFINO_HOME = home;
});

afterEach(async () => {
  while (workspaces.length > 0) workspaces.pop()!.dispose();
  while (cleanup.length > 0) {
    await removeRefino(cleanup.pop()!);
  }
  delete process.env.REFINO_HOME;
  delete process.env.REFINO_AUTHORIZATION;
  await rm(home, { recursive: true, force: true });
});

async function fixtureWorkspace(): Promise<RefinoWorkspace> {
  const root = await createRefino({
    "nodes/P1/PREMISE-premise.md": premise("P1PREMISE", "事实一"),
    "nodes/R1/ROOT-constraint.md": constraint("R1ROOT", undefined, "根约束"),
    "nodes/C1/CHILD-constraint.md": constraint("C1CHILD", ["R1ROOT", "P1PREMISE"], "子约束"),
    "nodes/C2/GRAND-constraint.md": constraint("C2GRAND", ["C1CHILD"], "孙约束"),
  });
  cleanup.push(root);
  const ws = await RefinoWorkspace.open(root + "/.refino");
  workspaces.push(ws);
  return ws;
}

interface Harness {
  tools: Record<string, ToolDefinition>;
  injected: string[];
  origin: AuthorizationOrigin;
  approve: (outcome: ApprovalOutcome) => void;
  /** Replace the approval stub with arbitrary behavior (concurrent signings). */
  interceptApproval: (impl: (reason: string) => Promise<ApprovalOutcome>) => void;
}

function signingHarness(ws: RefinoWorkspace): Harness {
  const injected: string[] = [];
  const origin: AuthorizationOrigin = { source: "default", revision: 0, signedAt: "" };
  let approval: (reason: string) => Promise<ApprovalOutcome> = async () => "allowed-once";
  const deps: SigningDeps = {
    get: () => ws,
    requestApproval: (reason) => approval(reason),
    inject: (text) => {
      if (text !== undefined) injected.push(text);
    },
    origin: () => origin,
    setOrigin: (next) => Object.assign(origin, next),
    env: process.env,
  };
  const tools = Object.fromEntries(createSigningTools(deps).map((tool) => [tool.name, tool]));
  return {
    tools,
    injected,
    origin,
    approve: (outcome) => {
      approval = async () => outcome;
    },
    interceptApproval: (impl) => {
      approval = impl;
    },
  };
}

async function run<T>(tool: ToolDefinition, args: unknown): Promise<T> {
  return (await tool.execute(args, {} as never)) as T;
}

describe("refino_request_authorization", () => {
  it("signs on approval: persists the state lane, applies the zone and injects the delta", async () => {
    const ws = await fixtureWorkspace();
    const h = signingHarness(ws);
    const result = await run<{ ok: boolean; revision?: number; frozen_constraints?: number }>(
      h.tools.refino_request_authorization,
      { frozen_frontier: ["C1CHILD"], rationale: "任务需要细化根约束" },
    );
    expect(result.ok).toBe(true);
    expect(result.revision).toBe(1);
    // Zone of C1CHILD: constraints C1CHILD + R1ROOT plus premise P1PREMISE;
    // C2GRAND stays modifiable.
    expect(result.frozen_constraints).toBe(2);

    // The shared state lane holds the signed document.
    const state = await readWorkspaceState(workspaceStatePath(ws.workspaceRoot));
    expect(state?.current.revision).toBe(1);
    expect(state?.current.frozenFrontier).toEqual(["C1CHILD"]);
    // First signing seeds the history with the implicit default.
    expect(state?.history).toHaveLength(1);
    expect(state?.history[0]!.revision).toBe(0);

    // The live session enforces the new zone immediately.
    expect(ws.authorizationContext.frozen).toEqual(["C1CHILD"]);
    expect(ws.session.checkModification(["C2GRAND"])[0]!.allowed).toBe(true);
    expect(ws.session.checkModification(["R1ROOT"])[0]!.allowed).toBe(false);

    // The delta went out as one injected update.
    expect(h.injected).toHaveLength(1);
    expect(h.injected[0]).toContain("新增冻结约束（只读）: C1CHILD");
    expect(h.origin.source).toBe("workspace");
    expect(h.origin.revision).toBe(1);
    expect(h.origin.statePath).toBe(workspaceStatePath(ws.workspaceRoot));
  });

  it("keeps the authorization untouched when the user rejects", async () => {
    const ws = await fixtureWorkspace();
    const h = signingHarness(ws);
    h.approve("rejected");
    const result = await run<{ ok: boolean; outcome?: string }>(
      h.tools.refino_request_authorization,
      { frozen_frontier: ["C1CHILD"] },
    );
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("rejected");
    expect(result.error).toContain("拒绝");
    expect(await readWorkspaceState(workspaceStatePath(ws.workspaceRoot))).toBeUndefined();
    expect(ws.authorizationContext.frozen).toEqual(["R1ROOT"]);
    expect(h.injected).toHaveLength(0);
  });

  it("fails closed when the approval surface is unavailable", async () => {
    const ws = await fixtureWorkspace();
    const h = signingHarness(ws);
    h.approve("unavailable");
    const result = await run<{ ok: boolean; outcome?: string }>(
      h.tools.refino_request_authorization,
      { frozen_frontier: [] },
    );
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("unavailable");
    expect(ws.authorizationContext.frozen).toEqual(["R1ROOT"]);
  });

  it("refuses outright while an orchestrator credential is active", async () => {
    const ws = await fixtureWorkspace();
    const h = signingHarness(ws);
    h.interceptApproval(async () => {
      throw new Error("approval must not be requested");
    });
    process.env.REFINO_AUTHORIZATION = "/tmp/orchestrator-cred.json";
    const result = await run<{ ok: boolean; error?: string }>(
      h.tools.refino_request_authorization,
      { frozen_frontier: [] },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("编排者凭据");
  });

  it("reports invalid drafts without touching the approval surface", async () => {
    const ws = await fixtureWorkspace();
    const h = signingHarness(ws);
    h.interceptApproval(async () => {
      throw new Error("approval must not be requested");
    });
    const unknown = await run<{ ok: boolean; error?: string }>(
      h.tools.refino_request_authorization,
      { frozen_frontier: ["NOSUCH1"] },
    );
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("NOSUCH1");
    const premise = await run<{ ok: boolean; error?: string }>(
      h.tools.refino_request_authorization,
      { frozen_frontier: ["P1PREMISE"] },
    );
    expect(premise.ok).toBe(false);
    expect(premise.error).toContain("constraint");
  });

  it("detects a concurrent signing while the request was pending", async () => {
    const ws = await fixtureWorkspace();
    const h = signingHarness(ws);
    h.interceptApproval(async () => {
      // Someone else signs revision 1 while the human deliberates.
      const statePath = workspaceStatePath(ws.workspaceRoot);
      await writeOtherSigning(statePath);
      return "allowed-once";
    });
    const result = await run<{ ok: boolean; error?: string }>(
      h.tools.refino_request_authorization,
      { frozen_frontier: ["C1CHILD"] },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("revision 0");
    expect(ws.authorizationContext.frozen).toEqual(["R1ROOT"]);
  });
});

async function writeOtherSigning(statePath: string): Promise<void> {
  const { writeWorkspaceState } = await import("@refino/harness/state");
  await writeWorkspaceState(statePath, {
    current: {
      version: 1,
      signedAt: "2026-09-07T00:00:00.000Z",
      revision: 1,
      frozenFrontier: ["C2GRAND"],
    },
    history: [],
  });
}

describe("refino_context", () => {
  it("reports the default origin before any signing", async () => {
    const ws = await fixtureWorkspace();
    const h = signingHarness(ws);
    const result = await run<{
      source: string;
      revision: number;
      frontier: string[];
      frozen_constraints: number;
      anchors_complete: boolean;
      orchestrator_credential: boolean;
    }>(h.tools.refino_context, {});
    expect(result.source).toBe("default");
    expect(result.revision).toBe(0);
    expect(result.frontier).toEqual(["R1ROOT"]);
    expect(result.frozen_constraints).toBe(1);
    expect(result.anchors_complete).toBe(true);
    expect(result.orchestrator_credential).toBe(false);
  });

  it("reflects a signing made through the request tool", async () => {
    const ws = await fixtureWorkspace();
    const h = signingHarness(ws);
    await run(h.tools.refino_request_authorization, { frozen_frontier: ["C1CHILD"] });
    const result = await run<{
      source: string;
      revision: number;
      state_path?: string;
      frozen_premises: number;
    }>(h.tools.refino_context, {});
    expect(result.source).toBe("workspace");
    expect(result.revision).toBe(1);
    expect(result.state_path).toBe(workspaceStatePath(ws.workspaceRoot));
    expect(result.frozen_premises).toBe(1);
  });

  it("flags an active orchestrator credential", async () => {
    const ws = await fixtureWorkspace();
    const h = signingHarness(ws);
    process.env.REFINO_AUTHORIZATION = "/tmp/orchestrator-cred.json";
    const result = await run<{ orchestrator_credential: boolean }>(h.tools.refino_context, {});
    expect(result.orchestrator_credential).toBe(true);
  });
});
