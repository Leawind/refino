import { afterEach, describe, expect, it } from "vitest";
import { createPremise, createConstraint, deleteNode } from "@refino/storage";
import { premise, constraint, createRefino, removeRefino } from "@refino/testkit";
import { RefinoWorkspace } from "../src/workspace.js";

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

describe("RefinoWorkspace.open", () => {
  it("loads the graph under the default authorization context", async () => {
    const ws = await open(await fixture());
    expect(ws.graph.nodes.size).toBe(4);
    expect(ws.authorizationContext.frozen).toEqual(["R1ROOT"]);
    expect(ws.anchorsComplete).toBe(true);
    expect(ws.session.checkModification(["R1ROOT"])[0]!.allowed).toBe(false);
    expect(ws.session.checkModification(["C1CHILD"])[0]!.allowed).toBe(true);
  });

  it("reports load issues without failing", async () => {
    const root = await createRefino({
      "nodes/C1/BROKEN-constraint.md": constraint("C1BROKEN", ["MISSING"], "悬空依据"),
    });
    cleanup.push(root);
    const ws = await open(root);
    expect(ws.issues.length).toBeGreaterThan(0);
  });
});

describe("RefinoWorkspace.sync", () => {
  it("derives anchor delta events for externally added nodes", async () => {
    const refinoDir = (await fixture()) + "/.refino";
    const ws = await open(refinoDir.replace(/\/.refino$/, ""));
    const id = await createPremise(refinoDir, { body: "新前提" });
    const outcome = await ws.sync([id]);
    expect(outcome.delta).toContainEqual({ type: "anchor_added", id });
    expect(outcome.pending.map((node) => node.id)).toEqual([]);
  });

  it("flags the old-graph dependents of an externally deleted node for review", async () => {
    const refinoDir = (await fixture()) + "/.refino";
    const ws = await open(refinoDir.replace(/\/.refino$/, ""));
    await deleteNode(refinoDir, "C1CHILD");
    const outcome = await ws.sync(["C1CHILD"]);
    expect(outcome.delta).toEqual([{ type: "anchor_removed", id: "C1CHILD" }]);
    expect(outcome.pending.map((node) => node.id)).toEqual(["C2GRAND"]);
  });

  it("derives frozen-zone delta events when a new root constraint appears", async () => {
    const refinoDir = (await fixture()) + "/.refino";
    const ws = await open(refinoDir.replace(/\/.refino$/, ""));
    const id = await createConstraint(refinoDir, { body: "新根约束" });
    const outcome = await ws.sync([id]);
    expect(outcome.delta).toContainEqual({ type: "anchor_added", id });
    expect(outcome.delta).toContainEqual({ type: "frozen_added", id });
  });
});

describe("RefinoWorkspace.signContext", () => {
  it("signs an explicit context, returns the delta and checks the modification space against it", async () => {
    const ws = await open(await fixture());
    expect(ws.contextSigned).toBe(false);

    // The default context anchors every node, so narrowing to C2GRAND only
    // removes the other three; C1CHILD's ancestors stay frozen through the
    // new frozen list, so nothing leaves the zone.
    const delta = ws.signContext({ anchors: ["C2GRAND"], frozen: ["C1CHILD"] });
    expect(delta).toEqual([
      { type: "anchor_removed", id: "C1CHILD" },
      { type: "anchor_removed", id: "P1PREMISE" },
      { type: "anchor_removed", id: "R1ROOT" },
      { type: "frozen_added", id: "C1CHILD" },
    ]);
    expect(ws.contextSigned).toBe(true);
    expect(ws.authorizationContext).toEqual({ anchors: ["C2GRAND"], frozen: ["C1CHILD"] });
    expect(ws.session.checkModification(["C1CHILD"])[0]!.allowed).toBe(false);
    expect(ws.session.checkModification(["R1ROOT"])[0]!.allowed).toBe(false);
    expect(ws.session.checkModification(["C2GRAND"])[0]!.allowed).toBe(true);

    expect(() => ws.signContext({ anchors: ["NOSUCH1"], frozen: [] })).toThrow();
  });

  it("converges the signed context on sync instead of resetting to defaults", async () => {
    const refinoDir = (await fixture()) + "/.refino";
    const ws = await open(refinoDir.replace(/\/.refino$/, ""));
    ws.signContext({ anchors: ["C1CHILD", "C2GRAND"], frozen: ["C1CHILD"] });

    // C2GRAND is deleted externally: it drops out of the anchors; C1CHILD
    // and the frozen list survive — the context does NOT revert to defaults.
    await deleteNode(refinoDir, "C2GRAND");
    const outcome = await ws.sync(["C2GRAND"]);
    expect(outcome.delta).toEqual([{ type: "anchor_removed", id: "C2GRAND" }]);
    expect(ws.authorizationContext).toEqual({ anchors: ["C1CHILD"], frozen: ["C1CHILD"] });
    expect(ws.session.checkModification(["C1CHILD"])[0]!.allowed).toBe(false);
    expect(ws.anchorsComplete).toBe(true); // untouched by signing; defaults-only signal

    // A context-preserving external change emits no delta.
    const id = await createPremise(refinoDir, { body: "签名后的新前提" });
    const quiet = await ws.sync([id]);
    expect(quiet.delta).toEqual([]);
  });

  it("drops a frozen id that reappears as a different type instead of wedging sync", async () => {
    const refinoDir = (await fixture()) + "/.refino";
    const ws = await open(refinoDir.replace(/\/.refino$/, ""));
    ws.signContext({ anchors: ["C2GRAND"], frozen: ["C2GRAND"] });

    // C2GRAND deleted, then re-created as a premise under the same id: the
    // frozen list drops it (premises are never frozen) and its whole zone
    // unfreezes with it; the anchor survives — anchors may reference any
    // node type. The next sync validates cleanly instead of throwing.
    await deleteNode(refinoDir, "C2GRAND");
    await createPremise(refinoDir, { id: "C2GRAND", body: "同名前提" });
    const outcome = await ws.sync(["C2GRAND"]);
    expect(outcome.delta).toEqual([
      { type: "frozen_removed", id: "C1CHILD" },
      { type: "frozen_removed", id: "C2GRAND" },
      { type: "frozen_removed", id: "R1ROOT" },
    ]);
    expect(ws.authorizationContext.frozen).toEqual([]);
    expect(ws.authorizationContext.anchors).toEqual(["C2GRAND"]);
    expect(ws.session.checkModification(["C2GRAND"])[0]!.allowed).toBe(true);
  });
});

describe("delta coalescing", () => {
  it("merges bursts into one emission after the interval", async () => {
    const { DeltaCoalescer } = await import("../src/coalesce.js");
    const emitted: Array<{ delta: unknown[]; pending: string[] }> = [];
    const coalescer = new DeltaCoalescer(20, (delta, pending) =>
      emitted.push({ delta, pending: pending.map((node) => node.id) }),
    );
    const pendingNode = { id: "C2GRAND" } as never; // the coalescer only reads id
    coalescer.push({ delta: [{ type: "anchor_added", id: "A" }], pending: [] });
    coalescer.push({ delta: [{ type: "anchor_removed", id: "A" }], pending: [pendingNode] });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.delta).toHaveLength(2);
    expect(emitted[0]!.pending).toEqual(["C2GRAND"]);
    coalescer.dispose();
  });

  it("does not emit when nothing was pushed; dispose drops buffered state", async () => {
    const { DeltaCoalescer } = await import("../src/coalesce.js");
    const emitted: unknown[] = [];
    const coalescer = new DeltaCoalescer(10, () => emitted.push(1));
    coalescer.push({ delta: [{ type: "anchor_added", id: "A" }], pending: [] });
    coalescer.dispose();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(emitted).toHaveLength(0);
  });
});
