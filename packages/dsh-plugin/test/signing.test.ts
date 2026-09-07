import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { ApprovalOutcome } from "@deepseek-ai/dsh-user-approval";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";
import { createSigningTools, type AuthorizationOrigin, type SigningDeps } from "../src/signing.js";
import { RefinoWorkspace } from "@refino/harness/host";

/**
 * Dialogue signing, entirely in session memory: an approved signing applies
 * to the live workspace and updates the origin record — nothing is written
 * anywhere, so there is no state file to set up or assert against.
 */

const cleanup: string[] = [];
const workspaces: RefinoWorkspace[] = [];

afterEach(async () => {
  while (workspaces.length > 0) workspaces.pop()!.dispose();
  while (cleanup.length > 0) {
    await removeRefino(cleanup.pop()!);
  }
  delete process.env.REFINO_AUTHORIZATION;
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
  /** Replace the approval stub with arbitrary behavior. */
  interceptApproval: (impl: (reason: string) => Promise<ApprovalOutcome>) => void;
}

function signingHarness(ws: RefinoWorkspace): Harness {
  const injected: string[] = [];
  const origin: AuthorizationOrigin = { source: "default", signedAt: "" };
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
  it("signs on approval: applies the zone in session and injects the delta", async () => {
    const ws = await fixtureWorkspace();
    const h = signingHarness(ws);
    const result = await run<{
      ok: boolean;
      frontier?: string[];
      frozen_constraints?: number;
      frozen_premises?: number;
    }>(h.tools.refino_request_authorization, {
      frozen_frontier: ["C1CHILD"],
      rationale: "任务需要细化根约束",
    });
    expect(result.ok).toBe(true);
    // Zone of C1CHILD: constraints C1CHILD + R1ROOT plus premise P1PREMISE;
    // C2GRAND stays modifiable.
    expect(result.frozen_constraints).toBe(2);
    expect(result.frozen_premises).toBe(1);
    expect(result.frontier).toEqual(["C1CHILD"]);

    // The live session enforces the new zone immediately.
    expect(ws.authorizationContext.frozen).toEqual(["C1CHILD"]);
    expect(ws.session.checkModification(["C2GRAND"])[0]!.allowed).toBe(true);
    expect(ws.session.checkModification(["R1ROOT"])[0]!.allowed).toBe(false);

    // The delta went out as one injected update, and the origin moved.
    expect(h.injected).toHaveLength(1);
    expect(h.injected[0]).toContain("新增冻结约束（只读）: C1CHILD");
    expect(h.origin.source).toBe("session");
    expect(h.origin.signedAt).not.toBe("");
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
    expect(ws.authorizationContext.frozen).toEqual(["R1ROOT"]);
    expect(h.injected).toHaveLength(0);
    expect(h.origin.source).toBe("default");
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
    process.env.REFINO_AUTHORIZATION = join(tmpdir(), "orchestrator-cred.json");
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

  it("leaves no files behind after a signing", async () => {
    const ws = await fixtureWorkspace();
    const h = signingHarness(ws);
    await run(h.tools.refino_request_authorization, { frozen_frontier: ["C1CHILD"] });
    // The plugin must not persist anything: the .refino directory holds only
    // what the test fixture created (nodes/), never a signing artifact.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(ws.refinoDir);
    expect(entries).toEqual(["nodes"]);
  });
});

describe("refino_context", () => {
  it("reports the default origin before any signing", async () => {
    const ws = await fixtureWorkspace();
    const h = signingHarness(ws);
    const result = await run<{
      source: string;
      signed_at: string;
      frontier: string[];
      frozen_constraints: number;
      anchors_complete: boolean;
      orchestrator_credential: boolean;
    }>(h.tools.refino_context, {});
    expect(result.source).toBe("default");
    expect(result.frontier).toEqual(["R1ROOT"]);
    expect(result.frozen_constraints).toBe(1);
    expect(result.anchors_complete).toBe(true);
    expect(result.orchestrator_credential).toBe(false);
  });

  it("reflects a signing made through the request tool", async () => {
    const ws = await fixtureWorkspace();
    const h = signingHarness(ws);
    await run(h.tools.refino_request_authorization, { frozen_frontier: ["C1CHILD"] });
    const result = await run<{ source: string; signed_at: string; frozen_premises: number }>(
      h.tools.refino_context,
      {},
    );
    expect(result.source).toBe("session");
    expect(result.signed_at).not.toBe("");
    expect(result.frozen_premises).toBe(1);
  });

  it("flags an active orchestrator credential", async () => {
    const ws = await fixtureWorkspace();
    const h = signingHarness(ws);
    process.env.REFINO_AUTHORIZATION = join(tmpdir(), "orchestrator-cred.json");
    const result = await run<{ orchestrator_credential: boolean }>(h.tools.refino_context, {});
    expect(result.orchestrator_credential).toBe(true);
  });
});
