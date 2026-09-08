import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readNode } from "@refino/storage";
import type { ApprovalOutcome } from "@refino/harness";
import { RefinoWorkspace } from "@refino/harness/host";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";
import { createRefinoServer } from "../src/server.js";
import { createToolTable, type McpTool, type ToolTableDeps } from "../src/tools.js";
import { drainUpdate, enqueueUpdate } from "../src/queue.js";

/**
 * The MCP surface over the shared execution cores: the tool table's
 * execute/render pairs against a fixture workspace, the dialogue-signing
 * flow (including its queue delivery), and one protocol-level round trip
 * through the actual server over an in-memory transport.
 */

const cleanup: string[] = [];
const workspaces: RefinoWorkspace[] = [];
const delivered: Array<{ token: string; text: string }> = [];
let queueSeq = 0;

afterEach(async () => {
  while (workspaces.length > 0) workspaces.pop()!.dispose();
  while (delivered.length > 0) {
    await drainUpdate(delivered.pop()!.token);
  }
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
  const ws = await RefinoWorkspace.open(join(root, ".refino"));
  workspaces.push(ws);
  return ws;
}

interface Table {
  tools: Record<string, McpTool>;
  approve: (outcome: ApprovalOutcome) => void;
  delivered: string[];
}

function tableFor(ws: RefinoWorkspace): Table {
  const token = `mcpqueue${++queueSeq}`;
  const texts: string[] = [];
  let approval: () => Promise<ApprovalOutcome> = async () => "allowed-once";
  const deps: ToolTableDeps = {
    obtainWorkspace: async () => ws,
    requestApproval: () => approval(),
    deliver: (text) => {
      if (text !== undefined) {
        texts.push(text);
        delivered.push({ token, text });
        void enqueueUpdate(token, text);
      }
    },
    env: process.env,
  };
  return {
    tools: Object.fromEntries(createToolTable(deps).map((tool) => [tool.name, tool])),
    approve: (outcome) => {
      approval = async () => outcome;
    },
    delivered: texts,
  };
}

async function call<T>(tool: McpTool, args: Record<string, unknown> = {}): Promise<T> {
  return (await tool.execute(args)) as T;
}

describe("tool table", () => {
  it("lists nodes with issue counts and type filters", async () => {
    const ws = await fixtureWorkspace();
    const { tools } = tableFor(ws);
    const all = await call<{ total: number; issue_count: number }>(tools.list);
    expect(all.total).toBe(4);
    expect(all.issue_count).toBe(0);
    const premises = await call<{ total: number }>(tools.list, { node_type: "premise" });
    expect(premises.total).toBe(1);
  });

  it("shows full nodes with per-id errors, rendered as text", async () => {
    const ws = await fixtureWorkspace();
    const { tools } = tableFor(ws);
    const value = await call<{ results: { id: string; node?: { grounds?: string[] } }[] }>(
      tools.show,
      { ids: ["C1CHILD", "NOSUCH1"] },
    );
    expect(value.results[0]!.node!.grounds).toEqual(["R1ROOT", "P1PREMISE"]);
    expect(value.results[1]!.id).toBe("NOSUCH1");
    const text = tools.show.render(value);
    expect(text).toContain("## C1CHILD");
    expect(text).toContain("依据：R1ROOT, P1PREMISE");
    expect(text).toContain("## NOSUCH1");
  });

  it("writes through the guarded path: frozen targets escalate, modifiable ones persist", async () => {
    const ws = await fixtureWorkspace();
    const { tools } = tableFor(ws);
    const frozen = await call<{ ok: boolean; escalation?: { reason: string } }>(tools.update_node, {
      id: "R1ROOT",
      summary: "改根约束",
    });
    expect(frozen.ok).toBe(false);
    expect(frozen.escalation!.reason).toBe("node_frozen");
    const ok = await call<{ ok: boolean; pending: { id: string }[] }>(tools.update_node, {
      id: "C1CHILD",
      body: "新正文",
    });
    expect(ok.ok).toBe(true);
    expect(ok.pending.map((node) => node.id)).toEqual(["C2GRAND"]);
    const read = await readNode(ws.refinoDir, "C1CHILD");
    expect(read.node?.summary).toBe("新正文"); // derived summary follows the body
  });

  it("reports inactivity instead of taking over a repo without .refino", async () => {
    // A table wired to no workspace: every tool must fail with the inactivity
    // notice rather than assuming adoption.
    const table = Object.fromEntries(
      createToolTable({
        obtainWorkspace: async () => undefined,
        deliver: () => {},
      }).map((tool) => [tool.name, tool]),
    );
    await expect(call(table.show, { ids: ["X"] })).rejects.toThrow("未找到 .refino");
  });
});

describe("dialogue signing over MCP", () => {
  it("signs on approval, applies in memory and delivers the delta to the queue lane", async () => {
    const ws = await fixtureWorkspace();
    const table = tableFor(ws);
    const result = await call<{
      ok: boolean;
      frontier?: string[];
      frozen_constraints?: number;
    }>(table.tools.request_authorization, {
      frozen_frontier: ["C1CHILD"],
      rationale: "任务需要细化根约束",
    });
    expect(result.ok).toBe(true);
    expect(result.frontier).toEqual(["C1CHILD"]);
    expect(result.frozen_constraints).toBe(2);
    expect(ws.authorizationContext.frozen).toEqual(["C1CHILD"]);
    expect(table.delivered[0]).toContain("新增冻结约束（只读）: C1CHILD");
    const status = await call<{ source: string; frontier: string[] }>(table.tools.context);
    expect(status.source).toBe("session");
    expect(status.frontier).toEqual(["C1CHILD"]);
  });

  it("keeps the authorization untouched when the approval surface rejects", async () => {
    const ws = await fixtureWorkspace();
    const table = tableFor(ws);
    table.approve("rejected");
    const result = await call<{ ok: boolean; outcome?: string }>(
      table.tools.request_authorization,
      { frozen_frontier: [] },
    );
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("rejected");
    expect(ws.authorizationContext.frozen).toEqual(["R1ROOT"]);
    expect(table.delivered).toHaveLength(0);
  });

  it("refuses outright while an orchestrator credential is active", async () => {
    const ws = await fixtureWorkspace();
    const table = tableFor(ws);
    process.env.REFINO_AUTHORIZATION = "/nonexistent/credential.json";
    const result = await call<{ ok: boolean; error?: string }>(table.tools.request_authorization, {
      frozen_frontier: [],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("编排者凭据");
  });
});

describe("server protocol round trip", () => {
  it("lists the toolset and answers a call over an in-memory transport", async () => {
    const root = await createRefino({
      "nodes/P1/PREMISE-premise.md": premise("P1PREMISE", "事实一"),
      "nodes/R1/ROOT-constraint.md": constraint("R1ROOT", undefined, "根约束"),
    });
    cleanup.push(root);
    const server = createRefinoServer({ projectDir: root });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toContain("show");
    expect(names).toContain("request_authorization");
    expect(names).toHaveLength(14);
    const show = listed.tools.find((tool) => tool.name === "show")!;
    expect(show.inputSchema.type).toBe("object");

    const result = await client.callTool({ name: "show", arguments: { ids: ["R1ROOT"] } });
    expect(result.isError).toBeUndefined();
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("R1ROOT");
    expect(text).toContain("根约束，无依据");
    // Every result carries the session stamp — the hook handshake's basis.
    expect(text).toMatch(/refino-session:[0-9a-f]{18}$/);

    const missing = await client.callTool({ name: "no-such-tool", arguments: {} });
    expect(missing.isError).toBe(true);

    await client.close();
    await server.close();
  });
});
