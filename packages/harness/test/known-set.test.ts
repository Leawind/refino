import { afterEach, describe, expect, it } from "vitest";
import { buildGraph } from "refino";
import type { Graph, RefinoNode } from "refino";
import { createConstraint, updatePremise } from "@refino/storage";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";
import { RefinoWorkspace, runCreateConstraint, runDependents, runShow } from "../src/host.js";
import { contentHash, SessionKnownSet } from "../src/known-set.js";

/** Scripted store reads: revisions and content hashes the tests control. */
function readOf(revisions: Record<string, number>, hashes: Record<string, string> = {}) {
  return {
    revisionOf: (id: string) => revisions[id],
    hashOf: async (id: string) => hashes[id],
  };
}

function node(id: string, type: "premise" | "constraint", grounds?: string[]): RefinoNode {
  const base = {
    id,
    file: `nodes/${id.slice(0, 2)}/${id.slice(2)}-${type}.md`,
    summary: `summary of ${id}`,
    body: `body of ${id}`,
  };
  if (type === "premise") return { ...base, type };
  return { ...base, type, grounds: grounds ?? [] };
}

function graphOf(...nodes: RefinoNode[]): Graph {
  return buildGraph(nodes);
}

describe("SessionKnownSet (unit)", () => {
  it("diffs summary, grounds and children against recorded snapshots", async () => {
    const known = new SessionKnownSet();
    known.recordSummaries([node("X1NODE1", "constraint", ["R1ROOT1"])]);
    known.recordGroundsOf("X1NODE1", ["R1ROOT1"], "constraint");
    known.recordChildrenOf("X1NODE1", ["C1CHILD"], "constraint");
    // Grounds swap R1ROOT1 → P1PREM1, a new dependent appears, summary edited.
    const edited = { ...node("X1NODE1", "constraint", ["P1PREM1"]), summary: "edited summary" };
    const graph = graphOf(
      edited,
      node("P1PREM1", "premise"),
      node("C1CHILD", "constraint", ["X1NODE1"]),
      node("C2NEWCH", "constraint", ["X1NODE1"]),
    );
    const changes = await known.drainDiff(graph, readOf({}));
    expect(changes).toContainEqual({
      id: "X1NODE1",
      kind: "summary",
      from: "summary of X1NODE1",
      to: "edited summary",
    });
    expect(changes).toContainEqual({
      id: "X1NODE1",
      kind: "grounds",
      added: ["P1PREM1"],
      removed: ["R1ROOT1"],
    });
    expect(changes).toContainEqual({
      id: "X1NODE1",
      kind: "children",
      added: ["C2NEWCH"],
      removed: [],
    });
    // The pass re-synced: a second diff over the same graph is empty.
    expect(await known.drainDiff(graph, readOf({}))).toEqual([]);
  });

  it("reports deletions with the delivered summary and rebuilds by type", async () => {
    const known = new SessionKnownSet();
    known.recordSummaries([node("D1GONE1", "premise"), node("B1REBUIL", "constraint")]);
    const graph = graphOf(node("B1REBUIL", "premise"));
    const changes = await known.drainDiff(graph, readOf({}));
    expect(changes).toContainEqual({
      id: "D1GONE1",
      kind: "deleted",
      summary: "summary of D1GONE1",
    });
    expect(changes).toContainEqual({
      id: "B1REBUIL",
      kind: "rebuilt",
      fromType: "constraint",
      toType: "premise",
    });
  });

  it("flags content changes by revision drift, separating mtime-only rewrites by hash", async () => {
    const known = new SessionKnownSet();
    const seen = node("C1NODE1", "constraint");
    known.recordFull(seen, 3, contentHash({ body: "body of C1NODE1" }));
    const graph = graphOf(seen);

    // Revision drifted, hash identical: an mtime-only rewrite, nothing to say.
    expect(
      await known.drainDiff(
        graph,
        readOf({ C1NODE1: 4 }, { C1NODE1: contentHash({ body: "body of C1NODE1" }) }),
      ),
    ).toEqual([]);

    // Revision drifted again, hash differs now: a real content change.
    const changes = await known.drainDiff(
      graph,
      readOf({ C1NODE1: 5 }, { C1NODE1: contentHash({ body: "rewritten" }) }),
    );
    expect(changes).toEqual([{ id: "C1NODE1", kind: "content" }]);
  });

  it("reports id-level entries as touched on revision drift only", async () => {
    const known = new SessionKnownSet();
    const graph = graphOf(node("A1IDONLY", "premise"));
    known.recordIdOnly("A1IDONLY", "premise", 1);
    expect(await known.drainDiff(graph, readOf({ A1IDONLY: 1 }))).toEqual([]);
    expect(await known.drainDiff(graph, readOf({ A1IDONLY: 2 }))).toEqual([
      { id: "A1IDONLY", kind: "touched" },
    ]);
  });

  it("reabsorbs neighborhoods silently so own writes are never reported back", async () => {
    const known = new SessionKnownSet();
    known.recordSummaries([
      node("X1NODE1", "constraint"),
      node("C2NEWCH", "constraint", ["X1NODE1"]),
    ]);
    known.recordChildrenOf("X1NODE1", ["C2NEWCH"], "constraint");
    // A write creates Y grounded on X: X's dependents list changed.
    const graph = graphOf(
      node("X1NODE1", "constraint"),
      node("C2NEWCH", "constraint", ["X1NODE1"]),
      node("Y3NEWGR", "constraint", ["X1NODE1"]),
    );
    known.reabsorb(graph, ["Y3NEWGR"]);
    expect(await known.drainDiff(graph, readOf({}))).toEqual([]);
  });

  it("seeding resets the touched flag while harvesting sets it", () => {
    const known = new SessionKnownSet();
    known.recordIdOnly("A1IDONLY", "premise", 1);
    expect(known.touched).toBe(true);
    known.seedSummaries([node("B1NODE1", "premise")]);
    expect(known.touched).toBe(false);
    expect(known.size).toBe(1);
  });
});

const cleanup: string[] = [];
const workspaces: RefinoWorkspace[] = [];

afterEach(async () => {
  while (workspaces.length > 0) workspaces.pop()!.dispose();
  while (cleanup.length > 0) {
    await removeRefino(cleanup.pop()!);
  }
});

async function fixture(): Promise<string> {
  const root = await createRefino({
    "nodes/P1/PREMISE-premise.md": premise("P1PREMISE", "事实一"),
    "nodes/R1/ROOT-constraint.md": constraint("R1ROOT", undefined, "根约束"),
    "nodes/C1/CHILD-constraint.md": constraint("C1CHILD", ["R1ROOT", "P1PREMISE"], "子约束"),
    "nodes/C2/GRAND-constraint.md": constraint("C2GRAND", ["C1CHILD"], "孙约束"),
  });
  cleanup.push(root);
  return root;
}

async function open(root: string): Promise<RefinoWorkspace> {
  const ws = await RefinoWorkspace.open(root + "/.refino");
  workspaces.push(ws);
  return ws;
}

/** Apply an external (file-origin) change for ids the storage helper just wrote. */
async function externalChange(
  root: string,
  ws: RefinoWorkspace,
  ids: readonly string[],
  write: () => Promise<void>,
): Promise<void> {
  await write();
  await ws.store.applyChange({ changed: [...ids], origin: "file" });
}

describe("known set over a workspace", () => {
  it("seeds with the anchor baseline at open", async () => {
    const ws = await open(await fixture());
    expect(ws.known.size).toBe(4); // complete: anchors cover every node
  });

  it("stays silent for unknown nodes; new dependents surface through the known parent", async () => {
    const root = await fixture();
    const ws = await open(root);
    // The anchor block never delivered children lists: dependents does.
    await runDependents(ws, ["C1CHILD"]);
    const fresh = await createConstraint(root + "/.refino", {
      body: "新下游",
      grounds: ["C1CHILD"],
    });
    await ws.store.applyChange({ changed: [fresh], origin: "file" });
    const changes = await ws.knownDiff();
    expect(changes).toEqual([{ id: "C1CHILD", kind: "children", added: [fresh], removed: [] }]);
    // The new node itself is unknown: nothing else is reported.
  });

  it("reports content changes for shown nodes and collapses re-fetches", async () => {
    const root = await fixture();
    const ws = await open(root);
    await runShow(ws, ["P1PREMISE"]);
    await externalChange(root, ws, ["P1PREMISE"], async () => {
      await updatePremise(root + "/.refino", "P1PREMISE", { body: "事实一（修订）" });
    });
    // The premise's summary is body-derived: the body edit moves both.
    expect(await ws.knownDiff()).toEqual([
      { id: "P1PREMISE", kind: "summary", from: "事实一", to: "事实一（修订）" },
      { id: "P1PREMISE", kind: "content" },
    ]);

    // A show interleaved with a later change absorbs it: the next diff over
    // the same content has nothing left to report.
    await externalChange(root, ws, ["P1PREMISE"], async () => {
      await updatePremise(root + "/.refino", "P1PREMISE", { body: "事实一（再修订）" });
    });
    await runShow(ws, ["P1PREMISE"]);
    expect(await ws.knownDiff()).toEqual([]);
  });

  it("absorbs own writes so the author is not notified about them", async () => {
    const root = await fixture();
    const ws = await open(root);
    await runDependents(ws, ["C1CHILD"]);
    const result = await runCreateConstraint(ws, { body: "模型写的下游", grounds: ["C1CHILD"] });
    expect(result.ok).toBe(true);
    expect(await ws.knownDiff()).toEqual([]);
  });
});
