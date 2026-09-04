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
