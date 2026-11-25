import { afterEach, describe, expect, it } from "vitest";
import { createDecision, createPremise, deleteNode } from "@refino/storage";
import { decision, premise, createRefino, removeRefino } from "@refino/testkit";
import { RefinoWorkspace, type SyncOutcome } from "../src/host.js";

const cleanup: string[] = [];
const workspaces: RefinoWorkspace[] = [];

afterEach(async () => {
  while (workspaces.length > 0) workspaces.pop()!.dispose();
  while (cleanup.length > 0) {
    await removeRefino(cleanup.pop()!);
  }
});

/** Open a workspace for a testkit root (the `.refino` dir is appended). */
async function open(testkitRoot: string): Promise<RefinoWorkspace> {
  const ws = await RefinoWorkspace.open(testkitRoot + "/.refino");
  workspaces.push(ws);
  return ws;
}

/**
 * Open a workspace that records the outcomes of external (file-event) syncs,
 * and apply an external change through the store's incremental entry.
 */
async function openListening(testkitRoot: string): Promise<{
  ws: RefinoWorkspace;
  outcomes: SyncOutcome[];
  externalChange: (ids: readonly string[], write: () => Promise<unknown>) => Promise<void>;
}> {
  const outcomes: SyncOutcome[] = [];
  const ws = await RefinoWorkspace.open(testkitRoot + "/.refino", (outcome) =>
    outcomes.push(outcome),
  );
  workspaces.push(ws);
  return {
    ws,
    outcomes,
    externalChange: async (ids, write) => {
      await write();
      await ws.store.applyChange({ changed: ids, origin: "file" });
    },
  };
}

async function fixture(): Promise<string> {
  const root = await createRefino({
    "nodes/P1/PREMISE-premise.md": premise("P1PREMISE", "事实一"),
    "nodes/R1/ROOT-decision.md": decision("R1ROOT", undefined, "根决策"),
    "nodes/C1/CHILD-decision.md": decision("C1CHILD", ["R1ROOT", "P1PREMISE"], "子决策"),
    "nodes/C2/GRAND-decision.md": decision("C2GRAND", ["C1CHILD"], "孙决策"),
  });
  cleanup.push(root);
  return root;
}

describe("RefinoWorkspace.open", () => {
  it("loads the graph and anchors every node under the auto-anchor budget", async () => {
    const ws = await open(await fixture());
    expect(ws.graph.nodes.size).toBe(4);
    expect(ws.anchorsComplete).toBe(true);
    expect(ws.session.anchorIds).toEqual(["C1CHILD", "C2GRAND", "P1PREMISE", "R1ROOT"]);
  });

  it("reports load issues without failing", async () => {
    const root = await createRefino({
      "nodes/C1/BROKEN-decision.md": decision("C1BROKEN", ["MISSING"], "悬空依据"),
    });
    cleanup.push(root);
    const ws = await open(root);
    expect(ws.issues.length).toBeGreaterThan(0);
  });

  it("reports review debt from the node timestamps", async () => {
    const root = await createRefino({
      "nodes/R1/ROOT-decision.md": decision(
        "R1ROOT",
        undefined,
        "根决策",
        undefined,
        true,
        "2025-01-01T00:00:00Z",
      ),
      "nodes/C1/CHILD-decision.md": decision("C1CHILD", ["R1ROOT"], "子决策"),
    });
    cleanup.push(root);
    const ws = await open(root);
    const report = ws.stale(Date.parse("2026-05-01T00:00:00Z"));
    expect(report.overdue.map((node) => node.id)).toEqual(["R1ROOT"]);
    expect(report.never.map((node) => node.id)).toEqual(["C1CHILD"]);
  });
});

describe("external changes", () => {
  it("derive anchor delta events for externally added nodes", async () => {
    const root = await fixture();
    const { ws, outcomes } = await openListening(root);
    const id = await createPremise(root + "/.refino", { body: "新前提" });
    await ws.store.applyChange({ changed: [id], origin: "file" });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.delta).toContainEqual({ type: "anchor_added", id });
    expect(outcomes[0]!.changed).toEqual([id]);
    expect(outcomes[0]!.deleted).toEqual([]);
    expect(outcomes[0]!.pending.map((node) => node.id)).toEqual([]);
  });

  it("flag the old-graph dependents of an externally deleted node for review", async () => {
    const root = await fixture();
    const { externalChange, outcomes } = await openListening(root);
    await externalChange(["C1CHILD"], async () => {
      await deleteNode(root + "/.refino", "C1CHILD");
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.delta).toEqual([{ type: "anchor_removed", id: "C1CHILD" }]);
    expect(outcomes[0]!.changed).toEqual([]);
    expect(outcomes[0]!.deleted).toEqual(["C1CHILD"]);
    expect(outcomes[0]!.pending.map((node) => node.id)).toEqual(["C2GRAND"]);
  });

  it("reports a new root decision as an anchor only", async () => {
    const root = await fixture();
    const { ws, outcomes } = await openListening(root);
    const id = await createDecision(root + "/.refino", { body: "新根决策" });
    await ws.store.applyChange({ changed: [id], origin: "file" });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.delta).toContainEqual({ type: "anchor_added", id });
  });

  it("keeps the known set quiet about nodes it never delivered", async () => {
    const root = await fixture();
    const { ws, externalChange } = await openListening(root);
    await externalChange(["C2GRAND"], async () => {
      await deleteNode(root + "/.refino", "C2GRAND");
    });
    expect(await ws.knownDiff()).toEqual([{ id: "C2GRAND", kind: "deleted", summary: "孙决策" }]);
    expect(await ws.knownDiff()).toEqual([]); // the diff drains per call
  });
});

describe("graphs above the auto-anchor budget", () => {
  it("inject no anchors and keep new nodes out of the delta", async () => {
    const { derivedAnchors } = await import("../src/index.js");
    const graph = (await import("refino")).buildGraph(
      Array.from({ length: 3 }, (_, i) => ({
        id: `R${i}ROOT`,
        type: "decision" as const,
        summary: `root ${i}`,
        grounds: [] as string[],
      })),
    );
    expect(derivedAnchors(graph, 2)).toEqual({ anchors: [], complete: false });
    expect(derivedAnchors(graph, 3)).toEqual({
      anchors: ["R0ROOT", "R1ROOT", "R2ROOT"],
      complete: true,
    });
  });
});

describe("delta coalescing", () => {
  it("merges bursts into one emission; the known diff is taken at fire time", async () => {
    const { DeltaCoalescer } = await import("../src/coalesce.js");
    const emitted: Array<{ delta: unknown[]; pending: string[]; known: string[] }> = [];
    const knownScript: string[][] = [[]];
    const diffCalls: number[] = [];
    const coalescer = new DeltaCoalescer(20, {
      knownDiff: async () => {
        diffCalls.push(Date.now());
        return knownScript[0]!.map((id) => ({ id, kind: "touched" }));
      },
      emit: (delta, pending, known) =>
        emitted.push({
          delta,
          pending: pending.map((node) => node.id),
          known: known.map((change) => change.id),
        }),
    });
    const pendingNode = { id: "C2GRAND" } as never; // the coalescer only reads id
    coalescer.push({
      delta: [{ type: "anchor_added", id: "A" }],
      changed: ["A"],
      deleted: [],
      pending: [],
    });
    coalescer.push({
      delta: [{ type: "anchor_removed", id: "A" }],
      changed: ["B"],
      deleted: [],
      pending: [pendingNode, pendingNode], // deduped by id within the window
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.delta).toHaveLength(2);
    expect(emitted[0]!.pending).toEqual(["C2GRAND"]);
    expect(diffCalls).toHaveLength(1); // one diff per fire, not per push
    coalescer.dispose();
  });

  it("does not emit when the delta, pending and known diff are all empty", async () => {
    const { DeltaCoalescer } = await import("../src/coalesce.js");
    const emitted: unknown[] = [];
    const coalescer = new DeltaCoalescer(10, {
      knownDiff: async () => [],
      emit: () => emitted.push(1),
    });
    coalescer.push({ delta: [], changed: ["A"], deleted: [], pending: [] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(emitted).toHaveLength(0);
  });

  it("does not emit when nothing was pushed; dispose drops buffered state", async () => {
    const { DeltaCoalescer } = await import("../src/coalesce.js");
    const emitted: unknown[] = [];
    const coalescer = new DeltaCoalescer(10, {
      knownDiff: async () => [{ id: "X", kind: "touched" }],
      emit: () => emitted.push(1),
    });
    coalescer.push({
      delta: [{ type: "anchor_added", id: "A" }],
      changed: ["A"],
      deleted: [],
      pending: [],
    });
    coalescer.dispose();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(emitted).toHaveLength(0);
  });
});
