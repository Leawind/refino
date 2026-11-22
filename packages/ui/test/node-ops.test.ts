// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefinoClient } from "../src/api";
import { setConfirmer, setMessenger } from "../src/feedback";
import { createNodeOps, type NodeOps } from "../src/nodeOps";
import { createStore } from "../src/store";
import { createWorkspace, type Workspace } from "../src/workspace";
import type { NodeDetail } from "../src/types";

/**
 * Canvas-side node operations (ui DESIGN.md, "编辑功能"): the connect
 * gesture writes a ground directly unless a live edit session owns the
 * node (the ground joins its draft), and deletion is blocked by dependents
 * or confirmed before the store removes.
 */

const TARGET = "A1B2C3D4";
const GROUND = "D4E5F6G7";
const EXISTING = "1A2B3C4D";

interface FakeState {
  node: NodeDetail["node"] | null;
  revision: number;
  dependents: Array<{ id: string; type: "decision" | "premise"; summary: string }>;
  updated: Array<{ id: string; payload: Record<string, unknown>; revision: number | undefined }>;
  deleted: string[];
  failFetch: boolean;
  failNeighbors: boolean;
}

function makeClient(state: FakeState): RefinoClient {
  return {
    queryNeighbors: async () => {
      if (state.failNeighbors) throw new Error("offline");
      return [
        {
          id: TARGET,
          results: [
            { truncated: false, nodes: [{ id: TARGET, type: "decision", summary: "", depth: 0 }] },
          ],
        },
        {
          id: TARGET,
          results: [
            { truncated: false, nodes: state.dependents.map((node) => ({ ...node, depth: 1 })) },
          ],
        },
      ];
    },
    queryExpand: async () => [],
    queryRange: async () => ({ mode: "disconnected", nodes: [] }),
    queryGrounds: async () => [],
    search: async () => ({ nodes: [] }),
    fetchNode: async () => {
      if (state.failFetch || state.node === null) throw new Error("gone");
      return { revision: state.revision, node: state.node, issues: [] };
    },
    fetchIssues: async () => ({ ok: true, issues: [], revision: 0 }),
    reloadGraph: async () => ({ revision: 0, changed: [], deleted: [] }),
    createNode: async () => {
      throw new Error("not used");
    },
    updateNode: async (id, payload, revision) => {
      state.updated.push({ id, payload, revision });
    },
    deleteNode: async (id) => {
      state.deleted.push(id);
    },
    connectEvents: () => () => {},
  };
}

const t = (key: string, named?: Record<string, unknown>): string =>
  named === undefined ? key : `${key}:${JSON.stringify(named)}`;

let state: FakeState;
let workspace: Workspace;
let store: ReturnType<typeof createStore>;
let ops: NodeOps;
let notices: Array<{ message: string; type: string }>;
let confirms: Array<{ content: string; onConfirm: () => void }>;

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  state = {
    node: {
      id: TARGET,
      type: "decision",
      summary: "S",
      body: "B",
      grounds: [EXISTING],
      rationale: "R",
      exploring: true,
      confirmed: Date.UTC(2026, 0, 1),
    },
    revision: 7,
    dependents: [],
    updated: [],
    deleted: [],
    failFetch: false,
    failNeighbors: false,
  };
  const client = makeClient(state);
  workspace = createWorkspace(client);
  store = createStore(client, workspace);
  ops = createNodeOps(client, store, workspace, t);
  notices = [];
  confirms = [];
  setMessenger((message, type) => notices.push({ message, type }));
  setConfirmer((options) => confirms.push(options));
});

afterEach(() => {
  workspace.stop();
  setMessenger(null);
  setConfirmer(null);
});

describe("nodeOps.addGround", () => {
  it("appends the ground and saves with the fetched revision and explicit fields", async () => {
    const outcome = await ops.addGround(TARGET, GROUND);
    expect(outcome).toBe("added");
    expect(state.updated).toHaveLength(1);
    const { id, payload, revision } = state.updated[0]!;
    expect(id).toBe(TARGET);
    expect(revision).toBe(7);
    expect(payload.grounds).toEqual([EXISTING, GROUND]);
    // The exploring boolean is always stated; confirmed goes back as RFC 3339.
    expect(payload.exploring).toBe(true);
    expect(payload.confirmed).toBe("2026-01-01T00:00:00.000Z");
    expect(payload.body).toBe("B");
  });

  it("reports a duplicate without writing", async () => {
    const outcome = await ops.addGround(TARGET, EXISTING);
    expect(outcome).toBe("duplicate");
    expect(state.updated).toHaveLength(0);
  });

  it("joins the draft of a live edit session instead of writing", async () => {
    store.openDetail(TARGET);
    await vi.waitFor(() => expect(store.state.detail.node).not.toBeNull());
    const outcome = await ops.addGround(TARGET, GROUND);
    expect(outcome).toBe("draft");
    expect(store.form.grounds).toEqual([EXISTING, GROUND]);
    expect(state.updated).toHaveLength(0);
  });

  it("fails closed when the node cannot be fetched or is a premise", async () => {
    state.failFetch = true;
    expect(await ops.addGround(TARGET, GROUND)).toBe("error");
    state.failFetch = false;
    state.node = { id: TARGET, type: "premise", summary: "", body: "" };
    expect(await ops.addGround(TARGET, GROUND)).toBe("error");
    expect(state.updated).toHaveLength(0);
  });
});

describe("nodeOps.deleteNode", () => {
  it("blocks with a notice while dependents exist", async () => {
    state.dependents = [{ id: GROUND, type: "decision", summary: "下游" }];
    await ops.deleteNode(TARGET);
    expect(notices).toEqual([{ message: t("node.deleteBlocked", { count: 1 }), type: "warning" }]);
    expect(confirms).toHaveLength(0);
    expect(state.deleted).toHaveLength(0);
  });

  it("names the node by summary in the delete confirmation", async () => {
    workspace.toggle({ id: TARGET, type: "decision", summary: "摘要节点" });
    await vi.waitFor(() =>
      expect(workspace.displayed.value.some((node) => node.id === TARGET)).toBe(true),
    );
    await ops.deleteNode(TARGET);
    expect(confirms[0]!.content).toBe(t("node.deleteConfirm", { node: "摘要节点" }));
  });

  it("confirms and then removes through the store", async () => {
    await ops.deleteNode(TARGET);
    expect(confirms).toHaveLength(1);
    expect(state.deleted).toHaveLength(0);
    confirms[0]!.onConfirm();
    // The success notice lands a tick after the deletion commit.
    await vi.waitFor(() =>
      expect(notices).toContainEqual({ message: "canvas.nodeDeleted", type: "success" }),
    );
    expect(state.deleted).toEqual([TARGET]);
  });

  it("notices when the dependency check fails", async () => {
    state.failNeighbors = true;
    await ops.deleteNode(TARGET);
    expect(notices).toEqual([{ message: "canvas.deleteFailed", type: "error" }]);
    expect(confirms).toHaveLength(0);
  });
});
