import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGraph } from "refino";
import type { Graph, NodeType, RefinoNode } from "refino";
import {
  HISTORY_LIMIT,
  effectiveContext,
  orchestratorCredential,
  readWorkspaceState,
  refinoHome,
  removeWorkspaceState,
  resolveAuthorization,
  workspaceStatePath,
  writeCredentialFile,
  writeWorkspaceState,
} from "../src/state.js";

function node(id: string, type: NodeType, grounds?: string[]): RefinoNode {
  if (type === "premise") return { id, type: "premise", summary: "Body." };
  return { id, type: "constraint", summary: "Body.", grounds: grounds ?? [] };
}

/** Two-root fixture so the default frontier has two entries. */
function graphOf(): Graph {
  return buildGraph([
    node("1A2B3C4D", "premise"),
    node("A1B2C3D4", "constraint"),
    node("D4E5F6G7", "constraint", ["1A2B3C4D", "A1B2C3D4"]),
    node("Z9Y8X7W6", "constraint"),
  ]);
}

let home = "";
let root = "";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "refino-home-"));
  root = await mkdtemp(join(tmpdir(), "refino-root-"));
  process.env.REFINO_HOME = home;
});

afterEach(async () => {
  delete process.env.REFINO_HOME;
  delete process.env.REFINO_AUTHORIZATION;
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

describe("refinoHome / workspaceStatePath", () => {
  it("keys the state file on the canonical root, so path variants share one file", async () => {
    const real = join(await realpath(root), "inner");
    await mkdir(real, { recursive: true });
    const link = join(await mkdtemp(join(tmpdir(), "refino-link-")), "link");
    await symlink(real, link, "dir");
    try {
      expect(workspaceStatePath(link)).toBe(workspaceStatePath(real));
    } finally {
      await rm(join(link, ".."), { recursive: true, force: true });
    }
  });

  it("places state files under REFINO_HOME", () => {
    expect(refinoHome()).toBe(home);
    expect(workspaceStatePath(root).startsWith(join(home, "workspaces"))).toBe(true);
  });
});

describe("workspace state file", () => {
  it("round-trips through write/read and reports missing files as undefined", async () => {
    const statePath = workspaceStatePath(root);
    expect(await readWorkspaceState(statePath)).toBeUndefined();
    const doc = {
      version: 1 as const,
      signedAt: "2026-09-06T08:30:00.000Z",
      revision: 2,
      frozenFrontier: ["D4E5F6G7"],
    };
    await writeWorkspaceState(statePath, { current: doc, history: [doc] });
    expect(await readWorkspaceState(statePath)).toEqual({ current: doc, history: [doc] });
    expect(await removeWorkspaceState(statePath)).toBe(true);
    expect(await removeWorkspaceState(statePath)).toBe(false);
    expect(await readWorkspaceState(statePath)).toBeUndefined();
  });

  it("rejects malformed state with a recovery hint", async () => {
    const statePath = workspaceStatePath(root);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(statePath, ".."), { recursive: true });
    await writeFile(statePath, "not json", "utf8");
    await expect(readWorkspaceState(statePath)).rejects.toThrow(/not valid JSON/);
  });

  it("bounds the history at HISTORY_LIMIT on read", async () => {
    const statePath = workspaceStatePath(root);
    const entry = (revision: number) => ({
      version: 1 as const,
      signedAt: "2026-09-06T08:30:00.000Z",
      revision,
      frozenFrontier: [],
    });
    const history = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => entry(i + 1));
    await writeWorkspaceState(statePath, { current: entry(0), history });
    const state = await readWorkspaceState(statePath);
    expect(state?.history).toHaveLength(HISTORY_LIMIT);
  });
});

describe("resolveAuthorization", () => {
  it("materializes the default when nothing is signed", async () => {
    const resolved = await resolveAuthorization(graphOf(), { root });
    expect(resolved.source).toBe("default");
    expect(resolved.doc.frozenFrontier).toEqual(["A1B2C3D4", "Z9Y8X7W6"]);
    expect(resolved.signed.revision).toBe(0);
  });

  it("prefers the workspace state over the default", async () => {
    const statePath = workspaceStatePath(root);
    await writeWorkspaceState(statePath, {
      current: {
        version: 1,
        signedAt: "2026-09-06T08:30:00.000Z",
        revision: 1,
        frozenFrontier: ["D4E5F6G7"],
      },
      history: [],
    });
    const resolved = await resolveAuthorization(graphOf(), { root });
    expect(resolved.source).toBe("workspace");
    expect(resolved.doc.frozenFrontier).toEqual(["D4E5F6G7"]);
    // Convergence re-minimalizes against the live graph: the frontier
    // covers the standalone root too unless it was signed out explicitly,
    // and a signed entry whose node vanished drops out.
  });

  it("prefers an orchestrator credential over everything and refuses workspace state paths", async () => {
    const credential = join(home, "cred.json");
    await writeCredentialFile(credential, {
      version: 1,
      signedAt: "2026-09-06T08:30:00.000Z",
      revision: 7,
      frozenFrontier: ["Z9Y8X7W6"],
    });
    const resolved = await resolveAuthorization(graphOf(), { root, authorization: credential });
    expect(resolved.source).toBe("orchestrator");
    expect(resolved.doc.frozenFrontier).toEqual(["Z9Y8X7W6"]);
    expect(resolved.statePath).toBeUndefined();
  });

  it("takes the credential from REFINO_AUTHORIZATION", async () => {
    expect(orchestratorCredential({})).toBeUndefined();
    process.env.REFINO_AUTHORIZATION = "/tmp/cred.json";
    expect(orchestratorCredential({})).toBe("/tmp/cred.json");
    expect(orchestratorCredential({ authorization: "/explicit.json" })).toBe("/explicit.json");
  });
});

describe("effectiveContext", () => {
  it("combines runtime-derived anchors with the signed frontier", async () => {
    const graph = graphOf();
    const resolved = await resolveAuthorization(graph, { root });
    const context = effectiveContext(graph, resolved);
    // Auto anchors cover every node; the default frontier freezes the roots.
    expect(context.anchors).toEqual(["1A2B3C4D", "A1B2C3D4", "D4E5F6G7", "Z9Y8X7W6"]);
    expect(context.frozen).toEqual(["A1B2C3D4", "Z9Y8X7W6"]);
  });
});
