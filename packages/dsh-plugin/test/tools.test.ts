import { afterEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { readNode } from "@refino/storage";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";
import { createTools } from "../src/tools.js";
import { RefinoWorkspace } from "../src/workspace.js";

const cleanup: string[] = [];
const workspaces: RefinoWorkspace[] = [];

afterEach(async () => {
  while (workspaces.length > 0) workspaces.pop()!.dispose();
  while (cleanup.length > 0) {
    await removeRefino(cleanup.pop()!);
  }
});

async function fixtureWorkspace(): Promise<RefinoWorkspace> {
  const root = await createRefino({
    "nodes/P1/PREMISE-premise.md": premise("P1PREMISE", "事实一"),
    "nodes/R1/ROOT-constraint.md": constraint("R1ROOT", undefined, "根约束"),
    "nodes/C1/CHILD-constraint.md": constraint(
      "C1CHILD",
      ["R1ROOT", "P1PREMISE"],
      "子约束",
      "因为根约束如此要求",
    ),
    "nodes/C2/GRAND-constraint.md": constraint("C2GRAND", ["C1CHILD"], "孙约束"),
  });
  cleanup.push(root);
  const ws = await RefinoWorkspace.open(root + "/.refino");
  workspaces.push(ws);
  return ws;
}

function toolset(ws: RefinoWorkspace): Record<string, ToolDefinition> {
  const tools = createTools(() => ws);
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

async function run<T>(tool: ToolDefinition, args: unknown): Promise<T> {
  return (await tool.execute(args, {} as never)) as T;
}

describe("query tools", () => {
  it("refino_list lists all nodes with totals and honors the type filter", async () => {
    const ws = await fixtureWorkspace();
    const tools = toolset(ws);
    const all = await run<{ total: number; nodes: unknown[] }>(tools.refino_list, {});
    expect(all.total).toBe(4);
    expect(all.nodes).toHaveLength(4);
    const premises = await run<{ total: number; nodes: { id: string }[] }>(tools.refino_list, {
      node_type: "premise",
    });
    expect(premises.total).toBe(1);
    expect(premises.nodes[0]!.id).toBe("P1PREMISE");
  });

  it("refino_show returns full nodes and per-id errors", async () => {
    const ws = await fixtureWorkspace();
    const tools = toolset(ws);
    const result = await run<{
      results: { id: string; node?: { grounds?: string[]; rationale?: string }; error?: string }[];
    }>(tools.refino_show, { ids: ["C1CHILD", "NOSUCH1"] });
    expect(result.results[0]!.node!.grounds).toEqual(["R1ROOT", "P1PREMISE"]);
    expect(result.results[0]!.node!.rationale).toBe("因为根约束如此要求");
    expect(result.results[1]!.error).toContain("NOSUCH1");
  });

  it("refino_grounds returns direct grounds", async () => {
    const ws = await fixtureWorkspace();
    const tools = toolset(ws);
    const result = await run<{ results: { id: string; nodes?: { id: string }[] }[] }>(
      tools.refino_grounds,
      { ids: ["C1CHILD", "R1ROOT"] },
    );
    expect(result.results[0]!.nodes!.map((node) => node.id).sort()).toEqual([
      "P1PREMISE",
      "R1ROOT",
    ]);
    expect(result.results[1]!.nodes).toEqual([]);
  });

  it("refino_ancestors and refino_dependents traverse with depth and honor max_depth", async () => {
    const ws = await fixtureWorkspace();
    const tools = toolset(ws);
    const up = await run<{ results: { nodes?: { id: string; depth: number }[] }[] }>(
      tools.refino_ancestors,
      { ids: ["C2GRAND"] },
    );
    expect(Object.fromEntries(up.results[0]!.nodes!.map((n) => [n.id, n.depth]))).toEqual({
      C1CHILD: 1,
      P1PREMISE: 2,
      R1ROOT: 2,
    });
    const upShallow = await run<{ results: { nodes?: { id: string }[] }[] }>(
      tools.refino_ancestors,
      { ids: ["C2GRAND"], max_depth: 1 },
    );
    expect(upShallow.results[0]!.nodes!.map((n) => n.id)).toEqual(["C1CHILD"]);
    const down = await run<{ results: { nodes?: { id: string }[] }[] }>(tools.refino_dependents, {
      ids: ["R1ROOT"],
    });
    expect(down.results[0]!.nodes!.map((n) => n.id).sort()).toEqual(["C1CHILD", "C2GRAND"]);
    await expect(
      run(tools.refino_dependents, { ids: ["R1ROOT"], max_depth: -1 }),
    ).rejects.toThrow();
  });

  it("refino_pending_review reports direct dependents and unknown ids", async () => {
    const ws = await fixtureWorkspace();
    const tools = toolset(ws);
    const result = await run<{ pending: { id: string }[]; unknown_ids: string[] }>(
      tools.refino_pending_review,
      { changed_ids: ["C1CHILD", "NOSUCH1"] },
    );
    expect(result.pending.map((node) => node.id)).toEqual(["C2GRAND"]);
    expect(result.unknown_ids).toEqual(["NOSUCH1"]);
  });

  it("refino_search matches id prefixes and summary substrings with keyset pages", async () => {
    const ws = await fixtureWorkspace();
    const tools = toolset(ws);
    const bySummary = await run<{ nodes: { id: string }[]; next_cursor?: string }>(
      tools.refino_search,
      { q: "约束" },
    );
    expect(bySummary.nodes.map((node) => node.id).sort()).toEqual(["C1CHILD", "C2GRAND", "R1ROOT"]);
    const paged = await run<{ nodes: { id: string }[]; next_cursor?: string }>(
      tools.refino_search,
      { q: "约束", limit: 2 },
    );
    expect(paged.nodes).toHaveLength(2);
    expect(paged.next_cursor).toBeDefined();
    const rest = await run<{ nodes: { id: string }[] }>(tools.refino_search, {
      q: "约束",
      limit: 2,
      cursor: paged.next_cursor,
    });
    expect(rest.nodes.map((node) => node.id)).toEqual(
      bySummary.nodes.map((node) => node.id).filter((id) => !paged.nodes.some((n) => n.id === id)),
    );
    const byPrefix = await run<{ nodes: { id: string }[] }>(tools.refino_search, { q: "C1" });
    expect(byPrefix.nodes.map((node) => node.id)).toEqual(["C1CHILD"]);
    const typed = await run<{ nodes: { id: string }[] }>(tools.refino_search, {
      node_type: "premise",
    });
    expect(typed.nodes.map((node) => node.id)).toEqual(["P1PREMISE"]);
  });

  it("refino_siblings ranks by shared direct grounds and honors the limit", async () => {
    const ws = await fixtureWorkspace();
    const tools = toolset(ws);
    // The fixture has no sibling pairs (C2GRAND is C1CHILD's child); add a
    // constraint sharing both of C1CHILD's grounds.
    const created = await run<{ ok: boolean }>(tools.refino_create_constraint, {
      id: "S1SIBLING",
      body: "兄弟约束",
      grounds: ["R1ROOT", "P1PREMISE"],
    });
    expect(created.ok).toBe(true);
    const result = await run<{
      results: { id: string; nodes?: { id: string; overlap: number }[]; error?: string }[];
    }>(tools.refino_siblings, { ids: ["C1CHILD", "P1PREMISE", "NOSUCH1"], limit: 1 });
    expect(result.results[0]!.nodes!.map((n) => [n.id, n.overlap])).toEqual([["S1SIBLING", 2]]);
    // Premises have no grounds, hence no siblings.
    expect(result.results[1]!.nodes).toEqual([]);
    expect(result.results[2]!.error).toContain("NOSUCH1");
  });
});

describe("write tools", () => {
  it("refino_create_premise creates a premise and rejects invalid timestamps", async () => {
    const ws = await fixtureWorkspace();
    const tools = toolset(ws);
    const bad = await run<{ ok: boolean }>(tools.refino_create_premise, {
      body: "事实",
      confirmed: "2026-09-05 大概",
    });
    expect(bad.ok).toBe(false);
    const ok = await run<{ ok: boolean; id: string }>(tools.refino_create_premise, {
      body: "事实二",
      confirmed: "2026-09-05T00:00:00Z",
    });
    expect(ok.ok).toBe(true);
    expect(ws.graph.nodes.get(ok.id)!.type).toBe("premise");
  });

  it("refino_create_constraint validates grounds against a prospective graph", async () => {
    const ws = await fixtureWorkspace();
    const tools = toolset(ws);
    const invalid = await run<{ ok: boolean; issues: { code: string }[] }>(
      tools.refino_create_constraint,
      { body: "新约束", grounds: ["NOSUCH1"] },
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.issues!.length).toBeGreaterThan(0);
    const duplicate = await run<{ ok: boolean }>(tools.refino_create_constraint, {
      body: "重复",
      id: "C1CHILD",
    });
    expect(duplicate.ok).toBe(false);
    const ok = await run<{ ok: boolean; id: string }>(tools.refino_create_constraint, {
      body: "挂在新前提下的约束",
      grounds: ["P1PREMISE"],
    });
    expect(ok.ok).toBe(true);
    expect(ws.graph.nodes.get(ok.id)!.type).toBe("constraint");
  });

  it("refino_update_node escalates for frozen targets and updates modifiable ones", async () => {
    const ws = await fixtureWorkspace();
    const tools = toolset(ws);
    const frozen = await run<{
      ok: boolean;
      escalation?: { reason: string; affected: { id: string }[] };
    }>(tools.refino_update_node, { id: "R1ROOT", summary: "改根约束", body: "改根约束" });
    expect(frozen.ok).toBe(false);
    expect(frozen.escalation!.reason).toBe("node_frozen");
    expect(frozen.escalation!.affected.map((a) => a.id).sort()).toEqual(["C1CHILD", "C2GRAND"]);
    // Partial semantics: grounds omitted keep the current ones.
    const bodyOnly = await run<{ ok: boolean; pending: { id: string }[] }>(
      tools.refino_update_node,
      { id: "C1CHILD", summary: "新摘要", body: "新正文" },
    );
    expect(bodyOnly.ok).toBe(true);
    expect(bodyOnly.pending.map((node) => node.id)).toEqual(["C2GRAND"]);
    const node = ws.graph.nodes.get("C1CHILD")!;
    expect(node.type === "constraint" && node.summary).toBe("新摘要");
    expect(node.type === "constraint" && node.grounds).toEqual(["R1ROOT", "P1PREMISE"]);
  });

  it("refino_update_node keeps a derived summary derived and clears via empty strings", async () => {
    const ws = await fixtureWorkspace();
    const tools = toolset(ws);
    // C2GRAND has no explicit summary (testkit premise/constraint leave it
    // derived): a body-only update must not pin one.
    const bodyOnly = await run<{ ok: boolean }>(tools.refino_update_node, {
      id: "C2GRAND",
      body: "孙约束新正文",
    });
    expect(bodyOnly.ok).toBe(true);
    const reloaded = await readNode(ws.refinoDir, "C2GRAND");
    expect(reloaded.summaryExplicit).toBe(false);
    expect(reloaded.node?.summary).toBe("孙约束新正文");
    // An explicit summary survives a body-only update…
    const explicit = await run<{ ok: boolean }>(tools.refino_update_node, {
      id: "C1CHILD",
      summary: "显式摘要",
      body: "子约束",
    });
    expect(explicit.ok).toBe(true);
    const kept = await run<{ ok: boolean }>(tools.refino_update_node, {
      id: "C1CHILD",
      body: "子约束二",
    });
    expect(kept.ok).toBe(true);
    const keptRead = await readNode(ws.refinoDir, "C1CHILD");
    expect(keptRead.summaryExplicit).toBe(true);
    expect(keptRead.node?.summary).toBe("显式摘要");
    // …and an empty string clears it back to body-derived.
    const cleared = await run<{ ok: boolean }>(tools.refino_update_node, {
      id: "C1CHILD",
      summary: "",
    });
    expect(cleared.ok).toBe(true);
    const clearedRead = await readNode(ws.refinoDir, "C1CHILD");
    expect(clearedRead.summaryExplicit).toBe(false);
    // rationale clears via an empty string; grounds validate on replacement.
    const rationale = await run<{ ok: boolean }>(tools.refino_update_node, {
      id: "C1CHILD",
      rationale: "",
    });
    expect(rationale.ok).toBe(true);
    const noRationale = await readNode(ws.refinoDir, "C1CHILD");
    expect(noRationale.node?.type === "constraint" && noRationale.node.rationale).toBeUndefined();
    const badGrounds = await run<{ ok: boolean; issues: unknown[] }>(tools.refino_update_node, {
      id: "C1CHILD",
      grounds: ["NOSUCH1"],
    });
    expect(badGrounds.ok).toBe(false);
    // Nothing to do is an error; so is an empty body.
    const nothing = await run<{ ok: boolean }>(tools.refino_update_node, { id: "C1CHILD" });
    expect(nothing.ok).toBe(false);
    const emptyBody = await run<{ ok: boolean }>(tools.refino_update_node, {
      id: "C1CHILD",
      body: "",
    });
    expect(emptyBody.ok).toBe(false);
  });

  it("refino_delete_node refuses frozen targets and nodes with dependents", async () => {
    const ws = await fixtureWorkspace();
    const tools = toolset(ws);
    const frozen = await run<{ ok: boolean; escalation?: { reason: string } }>(
      tools.refino_delete_node,
      { id: "R1ROOT" },
    );
    expect(frozen.ok).toBe(false);
    expect(frozen.escalation!.reason).toBe("node_frozen");
    const hasDependents = await run<{ ok: boolean; dependents: { id: string }[] }>(
      tools.refino_delete_node,
      { id: "C1CHILD" },
    );
    expect(hasDependents.ok).toBe(false);
    expect(hasDependents.dependents.map((node) => node.id)).toEqual(["C2GRAND"]);
    const ok = await run<{ ok: boolean }>(tools.refino_delete_node, { id: "C2GRAND" });
    expect(ok.ok).toBe(true);
    expect(ws.graph.nodes.has("C2GRAND")).toBe(false);
  });
});
