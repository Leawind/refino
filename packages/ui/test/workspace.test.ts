// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpClient } from "../src/api";
import { createWorkspace, type Workspace } from "../src/workspace";
import type { ChangeEvent, NodeLite } from "../src/types";

let workspace: Workspace;

/**
 * Workspace store behavior against the canvas query contract
 * (docs/design.md, "画布按需查询"). The fetch mock answers with hard-coded
 * fixtures mirroring packages/cli/test/web-query.test.ts — that suite pins
 * the server; here the same payloads pin the client.
 *
 *   P1 1A2B3C4D   P2 1A2B3C4E   P3 1A2B3C4F
 *   C1 A1B2C3D4 grounds [P1]
 *   C2 D4E5F6G7 grounds [C1, P2]
 *   C3 E5F6G7H8 grounds [C2]
 *   C4 H7J8K9M0 grounds [C1, P2]
 *   C5 N0P1Q2R3 grounds [P3]        (separate branch)
 *   C6 S4T5V6W7 grounds [P1, P2]
 */

const P1 = "1A2B3C4D";
const P2 = "1A2B3C4E";
const P3 = "1A2B3C4F";
const C1 = "A1B2C3D4";
const C2 = "D4E5F6G7";
const C3 = "E5F6G7H8";
const C4 = "H7J8K9M0";
const C5 = "N0P1Q2R3";
const C6 = "S4T5V6W7";

const lite: Record<string, NodeLite> = {
  [P1]: { id: P1, type: "premise", summary: "前提一。" },
  [P2]: { id: P2, type: "premise", summary: "前提二。" },
  [P3]: { id: P3, type: "premise", summary: "前提三。" },
  [C1]: { id: C1, type: "constraint", summary: "C1。", grounds: [P1] },
  [C2]: { id: C2, type: "constraint", summary: "C2。", grounds: [C1, P2] },
  [C3]: { id: C3, type: "constraint", summary: "C3。", grounds: [C2] },
  [C4]: { id: C4, type: "constraint", summary: "C4。", grounds: [C1, P2] },
  [C5]: { id: C5, type: "constraint", summary: "C5。", grounds: [P3] },
  [C6]: { id: C6, type: "constraint", summary: "C6。", grounds: [P1, P2] },
};

/** Nearest-first neighborhoods at the default depths (ancestors 2, descendants 2). Anchors come back at depth 0. */
const NEIGHBORHOODS: Record<string, Array<[string, number]>> = {
  [C1]: [
    [C1, 0],
    [P1, 1],
    [C2, 1],
    [C4, 1],
    [C6, 1],
    [C3, 2],
  ],
  [C2]: [
    [C2, 0],
    [C1, 1],
    [P2, 1],
    [C3, 1],
    [C4, 1],
    [P1, 2],
  ],
  [C3]: [
    [C3, 0],
    [C2, 1],
    [P2, 2],
    [C1, 2],
  ],
  [C4]: [
    [C4, 0],
    [C1, 1],
    [P2, 1],
    [P1, 2],
  ],
  [C5]: [
    [C5, 0],
    [P3, 1],
  ],
  [C6]: [
    [C6, 0],
    [P1, 1],
    [P2, 1],
  ],
};

/** Strong siblings as [id, overlap], overlap-descending then id-ascending. */
const SIBLINGS: Record<string, Array<[string, number]>> = {
  [C1]: [[C6, 1]],
  [C2]: [
    [C4, 2],
    [C6, 1],
  ],
  [C3]: [],
  [C4]: [
    [C2, 2],
    [C6, 1],
  ],
  [C5]: [],
  [C6]: [
    [C1, 1],
    [C2, 1],
    [C4, 1],
  ],
  [P1]: [],
};

const RANGES: Record<string, { mode: string; nodes: Array<[string, number | null]> }> = {
  [`${C3}->${C1}`]: {
    mode: "ancestor",
    nodes: [
      [C3, 0],
      [C2, 1],
      [C1, 2],
    ],
  },
  [`${C3}->${C5}`]: { mode: "branches", nodes: [[C5, null]] },
};

interface RecordedCall {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

let calls: RecordedCall[] = [];
/** Ids the mock server has dropped, mirroring the server-side index. */
let gone = new Set<string>();
/** The mock server's current revision; /api/validate always reports it. */
let serverRevision = 1;

function respond(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): {
  status: number;
  json: unknown;
} {
  calls.push({ method, path, body });
  if (method === "POST" && path === "/api/query/neighbors") {
    const ids = (body?.ids as string[]) ?? [];
    const limit = body?.limit as number | undefined;
    return {
      status: 200,
      json: ids.map((id) => {
        const all = (NEIGHBORHOODS[id] ?? []).filter(([nid]) => !gone.has(nid));
        // Depth filtering is not simulated: fixtures fit the default depths.
        const truncated = limit !== undefined && all.length > limit;
        const kept = truncated ? all.slice(0, limit) : all;
        return {
          id,
          results: [{ truncated, nodes: kept.map(([nid, depth]) => ({ ...lite[nid]!, depth })) }],
        };
      }),
    };
  }
  if (method === "POST" && path === "/api/query/siblings") {
    const ids = (body?.ids as string[]) ?? [];
    return {
      status: 200,
      json: ids.map((id) => ({
        id,
        results: [
          {
            truncated: false,
            nodes: (SIBLINGS[id] ?? [])
              .filter(([sid]) => !gone.has(sid))
              .map(([sid, overlap]) => ({ ...lite[sid]!, overlap })),
          },
        ],
      })),
    };
  }
  if (method === "POST" && path === "/api/query/range") {
    const route = RANGES[`${body?.focusId}->${body?.clickedId}`];
    if (
      route === undefined ||
      gone.has(body?.focusId as string) ||
      gone.has(body?.clickedId as string)
    ) {
      return { status: 404, json: { error: "Node does not exist." } };
    }
    return {
      status: 200,
      json: {
        mode: route.mode,
        nodes: route.nodes
          .filter(([id]) => !gone.has(id))
          .map(([id, depth]) => ({ ...lite[id]!, depth })),
      },
    };
  }
  if (method === "GET" && path === "/api/validate") {
    return { status: 200, json: { ok: true, issues: [], revision: serverRevision } };
  }
  return { status: 404, json: { error: "endpoint not mocked" } };
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  emit(event: ChangeEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  close(): void {
    this.closed = true;
  }
}

function lastCall(path: string): RecordedCall {
  const matching = calls.filter((call) => call.path === path);
  const found = matching[matching.length - 1];
  if (found === undefined) throw new Error(`no call to ${path}`);
  return found;
}

/** Displayed node ids, constraints first (the store's stable order). */
function displayedIds(): string[] {
  return workspace.displayed.value.map((node) => node.id);
}

async function select(id: string): Promise<void> {
  workspace.select(lite[id]!);
  await vi.waitFor(() => {
    expect(workspace.state.selection).toEqual([id]);
    expect(workspace.state.loading).toBe(false);
  });
}

beforeEach(() => {
  localStorage.clear();
  workspace = createWorkspace(createHttpClient());
  calls = [];
  gone = new Set();
  serverRevision = 1;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
      const response = respond(init?.method ?? "GET", path, JSON.parse(init?.body ?? "null"));
      return {
        ok: response.status < 400,
        status: response.status,
        json: async () => response.json,
      };
    }),
  );
  // Restore defaults; the config is module state persisted in localStorage.
  workspace.setConfig({
    ancestorDepth: 2,
    descendantDepth: 2,
    showSiblings: true,
    siblingLimit: 24,
    neighborhoodLimit: 400,
  });
  workspace.clearSelection();
  workspace.dismissNotice();
  workspace.dismissError();
});

afterEach(() => {
  workspace.stop();
  vi.unstubAllGlobals();
});

describe("select expands the working set", () => {
  it("unions the anchor, its neighborhood and its siblings", async () => {
    await select(C3);
    // The neighborhood carries the anchor itself, so the one neighbors call
    // also refreshes the anchor's lite shape (grounds included).
    expect(lastCall("/api/query/siblings").body).toMatchObject({ ids: [C3] });
    expect(lastCall("/api/query/neighbors").body).toMatchObject({
      ids: [C3],
      ancestorDepth: 2,
      descendantDepth: 2,
    });
    // Constraints of the working set, in coverage order; the premises of
    // the neighborhood join as the facts layer is on by default.
    expect(new Set(displayedIds())).toEqual(new Set([C3, C2, C1, P2]));
    expect(workspace.state.focusId).toBe(C3);
  });

  it("evicts nodes that leave all coverage when the selection moves", async () => {
    await select(C3);
    await select(C5);
    // The facts layer keeps the premise of the neighborhood visible.
    expect(displayedIds()).toEqual([C5, P3]);
  });

  it("includes strong siblings and their vertical neighborhoods", async () => {
    await select(C2);
    expect(lastCall("/api/query/neighbors").body).toMatchObject({ ids: [C2, C4, C6] });
    // Premise grounds of the coverage stay visible through the facts layer.
    expect(new Set(displayedIds())).toEqual(new Set([C2, C1, C3, C4, C6, P1, P2]));
  });

  it("skips siblings when disabled in the config", async () => {
    workspace.setConfig({ showSiblings: false });
    await select(C2);
    expect(lastCall("/api/query/neighbors").body).toMatchObject({ ids: [C2] });
    expect(new Set(displayedIds())).toEqual(new Set([C2, C1, P2, C3, C4, P1]));
  });

  it("surfaces the neighborhood truncation flag", async () => {
    workspace.setConfig({ neighborhoodLimit: 2 });
    workspace.select(lite[C1]!);
    await vi.waitFor(() => expect(workspace.state.truncated).toBe(true));
    expect(lastCall("/api/query/neighbors").body).toMatchObject({ limit: 2 });
  });
});

describe("selection model", () => {
  it("appends ancestor range paths in focus order", async () => {
    await select(C3);
    await workspace.rangeSelect(lite[C1]!);
    await vi.waitFor(() => expect(workspace.state.selection).toEqual([C3, C2, C1]));
    expect(workspace.state.focusId).toBe(C1);
    expect(workspace.state.notice).toBeNull();
  });

  it("degrades to the clicked node when no common ancestor exists", async () => {
    await select(C3);
    await workspace.rangeSelect(lite[C5]!);
    await vi.waitFor(() => expect(workspace.state.selection).toEqual([C3, C5]));
    expect(workspace.state.notice).toBe("rangeDegraded");
    workspace.dismissNotice();
  });

  it("toggles constraint membership", async () => {
    await select(C3);
    workspace.toggle(lite[C6]!);
    await vi.waitFor(() => expect(workspace.state.selection).toEqual([C3, C6]));
    workspace.toggle(lite[C6]!);
    await vi.waitFor(() => expect(workspace.state.selection).toEqual([C3]));
  });

  it("locates by moving the node to the focus position", async () => {
    await select(C3);
    await workspace.rangeSelect(lite[C1]!);
    await vi.waitFor(() => expect(workspace.state.selection).toEqual([C3, C2, C1]));
    workspace.setFocus(C3);
    expect(workspace.state.selection).toEqual([C2, C1, C3]);
    expect(workspace.state.focusId).toBe(C3);
  });

  it("clears to the empty working set", async () => {
    await select(C3);
    workspace.clearSelection();
    await vi.waitFor(() => expect(displayedIds()).toEqual([]));
    expect(workspace.state.focusId).toBeNull();
  });
});

describe("hover", () => {
  it("highlights the node without changing the display", async () => {
    await select(C1);
    expect(new Set(displayedIds())).toEqual(new Set([C1, P1, C6, P2, C2, C4, C3]));
    workspace.hover(C2);
    expect(workspace.state.hoveredId).toBe(C2);
    expect(new Set(displayedIds())).toEqual(new Set([C1, P1, C6, P2, C2, C4, C3]));
    workspace.unhover();
    expect(workspace.state.hoveredId).toBeNull();
  });
});

describe("external change feed", () => {
  it("applies reload events and refreshes on changes", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    workspace.start();
    const source = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    expect(workspace.isLive()).toBe(true);

    serverRevision = 7;
    source.emit({ revision: 7, changed: [], deleted: [], reload: true });
    await vi.waitFor(() => expect(workspace.state.revision).toBe(7));

    await select(C3);
    const neighborCalls = calls.filter((call) => call.path === "/api/query/neighbors").length;
    serverRevision = 8;
    source.emit({ revision: 8, changed: [C2], deleted: [] });
    await vi.waitFor(() => expect(workspace.state.revision).toBe(8));
    await vi.waitFor(() =>
      expect(calls.filter((call) => call.path === "/api/query/neighbors").length).toBeGreaterThan(
        neighborCalls,
      ),
    );
    // The working set survives an unrelated change.
    expect(workspace.state.selection).toEqual([C3]);
  });

  it("prunes deleted nodes from selection and cache", async () => {
    await select(C3);
    expect(new Set(displayedIds())).toEqual(new Set([C3, C2, C1, P2]));
    // The server has dropped C1; the client learns via the change feed.
    gone.add(C1);
    workspace.pruneDeleted([C1]);
    await vi.waitFor(() => expect(new Set(displayedIds())).toEqual(new Set([C3, C2, P2])));
    // Re-expanding from scratch does not revive the deleted node.
    workspace.clearSelection();
    await vi.waitFor(() => expect(displayedIds()).toEqual([]));
    workspace.select({ ...lite[C3]! });
    await vi.waitFor(() => expect(workspace.state.loading).toBe(false));
    expect(new Set(displayedIds())).toEqual(new Set([C3, C2, P2]));
  });

  it("stops the subscription on stop()", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    workspace.start();
    const source = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    workspace.stop();
    expect(source.closed).toBe(true);
    expect(workspace.isLive()).toBe(false);
  });
});

describe("premise facts layer", () => {
  it("excludes premises when the layer is switched off", async () => {
    workspace.setConfig({ showPremises: false });
    await select(C3);
    expect(new Set(displayedIds())).toEqual(new Set([C3, C2, C1]));
    // Turning the layer back on brings the neighborhood's premises in
    // without a refetch: they already live in the working set.
    workspace.setConfig({ showPremises: true });
    expect(new Set(displayedIds())).toEqual(new Set([C3, C2, C1, P2]));
  });
});
