// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpClient } from "../src/api";
import { createStore, type Store } from "../src/store";
import { createWorkspace, type Workspace } from "../src/workspace";
import type { ChangeEvent } from "../src/types";

let store: Store;
let workspace: Workspace;

/**
 * Detail editor conflict flow against the store: silent update without edits,
 * silent field-level merge, collision conflict with both resolutions,
 * optimistic-concurrency save and the recreate-after-external-deletion flow. The
 * fetch mock mirrors the server contract pinned by
 * packages/cli/test/web-api.test.ts.
 */

const ID = "A1B2C3D4";
const P1 = "1A2B3C4D";

interface NodeFile {
  type: "premise" | "decision";
  summary: string;
  body: string;
  grounds?: string[];
  rationale?: string;
}

let disk: Map<string, NodeFile>;
let serverRevision: number;
let putCalls: Array<{ id: string; body: Record<string, unknown> }> = [];

function nodeJson(id: string): Record<string, unknown> {
  const node = disk.get(id)!;
  return {
    id,
    type: node.type,
    summary: node.summary,
    body: node.body,
    ...(node.type === "decision" && { grounds: node.grounds ?? [] }),
    ...(node.type === "decision" && node.rationale !== undefined && { rationale: node.rationale }),
  };
}

const liteOf = (id: string) => ({
  id,
  type: disk.get(id)!.type,
  summary: disk.get(id)!.summary,
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  emit(event: ChangeEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  close(): void {}
}

function respond(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): {
  status: number;
  json: unknown;
} {
  if (method === "GET" && path.startsWith("/api/nodes/")) {
    const id = path.slice("/api/nodes/".length);
    if (!disk.has(id)) return { status: 404, json: { error: `Node "${id}" does not exist.` } };
    return { status: 200, json: { revision: serverRevision, node: nodeJson(id), issues: [] } };
  }
  if (method === "PUT" && path.startsWith("/api/nodes/")) {
    const id = path.slice("/api/nodes/".length);
    putCalls.push({ id, body: body ?? {} });
    const type = (body?.type as NodeFile["type"] | undefined) ?? disk.get(id)?.type;
    if (type === undefined) return { status: 400, json: { error: "type required" } };
    serverRevision++;
    disk.set(id, {
      type,
      summary: (body?.summary as string) ?? "",
      body: body?.body as string,
      ...(type === "decision" && { grounds: (body?.grounds as string[]) ?? [] }),
    });
    return { status: 200, json: { id, revision: serverRevision } };
  }
  if (method === "POST" && path === "/api/query/neighbors") {
    const ids = (body?.ids as string[]) ?? [];
    return {
      status: 200,
      json: ids.map((id) => ({
        id,
        results: [
          {
            truncated: false,
            nodes: (disk.get(id)?.grounds ?? []).map((g, i) => ({ ...liteOf(g), depth: i + 1 })),
          },
        ],
      })),
    };
  }
  if (method === "POST" && path === "/api/query/siblings") {
    const ids = (body?.ids as string[]) ?? [];
    return {
      status: 200,
      json: ids.map((id) => ({ id, results: [{ truncated: false, nodes: [] }] })),
    };
  }
  if (method === "GET" && path === "/api/validate") {
    return { status: 200, json: { ok: true, issues: [], revision: serverRevision } };
  }
  return { status: 404, json: { error: "endpoint not mocked" } };
}

function fixture(): void {
  disk = new Map<string, NodeFile>();
  disk.set(P1, { type: "premise", summary: "前提一", body: "前提一正文。" });
  disk.set(ID, { type: "decision", summary: "决策一", body: "决策一正文。", grounds: [P1] });
  serverRevision = 3;
}

async function waitFor<T>(probe: () => T | undefined): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not met");
}

/** Opens the editor sheet for ID from a clean slate and waits for node +
 * form. Reopening the same id deliberately skips the reload in production
 * (it protects unsaved edits), so tests reset the session first. */
async function openDetail(): Promise<void> {
  store.closeEditor();
  store.openEditor(ID);
  await waitFor(() => (store.state.detail.node !== null ? true : undefined));
  await waitFor(() => (store.state.detail.base !== null ? true : undefined));
}

/** Applies an external change event and waits for the detail to re-sync. */
async function emit(event: ChangeEvent): Promise<void> {
  FakeEventSource.instances[FakeEventSource.instances.length - 1]!.emit(event);
  await waitFor(() => (workspace.state.revision === event.revision ? true : undefined));
  await new Promise((resolve) => setTimeout(resolve, 150));
}

beforeEach(() => {
  localStorage.clear();
  fixture();
  putCalls = [];
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
  vi.stubGlobal("EventSource", FakeEventSource);
  FakeEventSource.instances = [];
  const client = createHttpClient();
  workspace = createWorkspace(client);
  store = createStore(client, workspace);
  workspace.start();
});

afterEach(async () => {
  workspace.stop();
  // Drain pending async store work so it cannot leak into the next test.
  await new Promise((resolve) => setTimeout(resolve, 60));
  vi.unstubAllGlobals();
});

describe("external change against the open editor", () => {
  it("adopts the external version wholesale when the user has no edits", async () => {
    await openDetail();

    disk.set(ID, { ...disk.get(ID)!, summary: "外部摘要" });
    serverRevision = 4;
    await emit({ revision: 4, changed: [ID], deleted: [] });

    expect(store.state.detail.node?.summary).toBe("外部摘要");
    expect(store.form.summary).toBe("外部摘要");
    expect(store.state.detail.revision).toBe(4);
    expect(store.state.detail.conflict).toBeNull();
  });

  it("merges field-by-field when the edits do not collide", async () => {
    await openDetail();
    store.form.body = "我的正文编辑";

    disk.set(ID, { ...disk.get(ID)!, summary: "外部摘要" });
    serverRevision = 4;
    await emit({ revision: 4, changed: [ID], deleted: [] });

    // The user's body edit survives; the summary adopts the external value.
    expect(store.form.body).toBe("我的正文编辑");
    expect(store.form.summary).toBe("外部摘要");
    expect(store.state.detail.revision).toBe(4);
    expect(store.state.detail.conflict).toBeNull();
    expect(store.state.detail.mergeNotice).toBe(1);
  });

  it("surfaces a conflict when both sides edited the same field", async () => {
    await openDetail();
    store.form.body = "我的正文编辑";

    disk.set(ID, { ...disk.get(ID)!, body: "外部正文", summary: "外部摘要" });
    serverRevision = 4;
    await emit({ revision: 4, changed: [ID], deleted: [] });

    expect(store.state.detail.conflict).not.toBeNull();
    expect(store.state.detail.conflict!.fields).toEqual(["body"]);
    expect(store.form.body).toBe("我的正文编辑"); // untouched until decided

    store.keepLocalOverConflict();
    expect(store.state.detail.conflict).toBeNull();
    expect(store.state.detail.revision).toBe(4); // next save overwrites legally
    expect(store.form.body).toBe("我的正文编辑");
  });

  it("loads the external version on apply", async () => {
    await openDetail();
    store.form.body = "我的正文编辑";

    disk.set(ID, { ...disk.get(ID)!, body: "外部正文" });
    serverRevision = 4;
    await emit({ revision: 4, changed: [ID], deleted: [] });
    expect(store.state.detail.conflict).not.toBeNull();

    store.applyConflictExternal();
    expect(store.state.detail.conflict).toBeNull();
    expect(store.form.body).toBe("外部正文");
    expect(store.state.detail.node?.body).toBe("外部正文");
  });

  it("sends the base revision with the save (If-Match)", async () => {
    await openDetail();
    const baseRevision = store.state.detail.revision;
    await store.update(ID, { body: "我的正文编辑" }, baseRevision ?? undefined);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]!.body.revision).toBe(baseRevision);
    // The save adopts the server's new revision as the next save's basis.
    expect(store.state.detail.revision).toBe(baseRevision + 1);
  });
});

describe("external deletion", () => {
  it("offers recreating the same id when the form holds unsaved edits", async () => {
    await openDetail();
    store.form.body = "未保存的编辑";

    disk.delete(ID);
    serverRevision = 5;
    await emit({ revision: 5, changed: [], deleted: [ID] });

    expect(store.state.detail.deletedWithEdits).toBe(true);

    await store.recreateDetail("decision");
    expect(disk.has(ID)).toBe(true);
    expect(store.state.detail.deletedWithEdits).toBe(false);
    expect(store.state.detail.node?.body).toBe("未保存的编辑");
  });

  it("closes the editor silently when the deletion meets no edits", async () => {
    await openDetail();
    disk.delete(ID);
    serverRevision = 5;
    await emit({ revision: 5, changed: [], deleted: [ID] });
    expect(store.state.detail.deletedWithEdits).toBe(false);
    expect(store.state.editorOpen).toBe(false);
    expect(store.state.detail.id).toBeNull();
  });
});

describe("recreate via PUT", () => {
  it("sends the payload type so the server can create the id", async () => {
    await openDetail();
    await store.recreateDetail("decision");
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]!.body.type).toBe("decision");
  });
});

describe("editor session", () => {
  it("stays pinned to its node while the canvas focus moves", async () => {
    await openDetail();
    store.form.body = "编辑中的正文";
    // Clicking another node moves the focus but never re-points the sheet:
    // the draft would have nowhere to live.
    workspace.select({ id: P1, type: "premise", summary: "前提一" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(store.state.detail.id).toBe(ID);
    expect(store.form.body).toBe("编辑中的正文");
  });

  it("parks a switch request with unsaved work and applies it on discard", async () => {
    await openDetail();
    store.form.body = "编辑中的正文";
    store.openEditor(P1);
    expect(store.state.detail.id).toBe(ID);
    expect(store.state.pendingEditor).toEqual({ kind: "open", id: P1 });

    await store.resolvePending("discard");
    await waitFor(() => (store.state.detail.node?.id === P1 ? true : undefined));
    expect(store.state.pendingEditor).toBeNull();
    expect(store.form.summary).toBe("前提一");
  });

  it("saves before switching when the request is resolved that way", async () => {
    await openDetail();
    store.form.body = "保存后切换";
    store.openEditor(P1);
    await store.resolvePending("save");
    expect(putCalls.some((call) => call.id === ID)).toBe(true);
    await waitFor(() => (store.state.detail.node?.id === P1 ? true : undefined));
  });

  it("closing discards the session", async () => {
    await openDetail();
    store.form.body = "未保存";
    expect(store.isDirty(ID)).toBe(true);
    store.closeEditor();
    expect(store.state.editorOpen).toBe(false);
    expect(store.state.detail.id).toBeNull();
    expect(store.form.body).toBe("");
  });

  it("keeps the sheet open across a save", async () => {
    await openDetail();
    store.form.body = "已保存的正文";
    await store.saveCurrent();
    expect(store.state.editorOpen).toBe(true);
    expect(store.state.detail.id).toBe(ID);
    expect(store.isDirty(ID)).toBe(false);
  });
});
