import type { InjectionKey } from "vue";
import type {
  ChangeEvent,
  IssueRecord,
  Neighborhood,
  NodeDetail,
  NodePayload,
  QueryGroup,
  RangeResult,
  SearchNode,
  SearchPage,
  SiblingSet,
} from "./types";

/**
 * The data channel of the embeddable editor shell (docs/design.md, "前端技
 * 术栈": hosts provide the container and the data channel). `createWorkspace`
 * and `createStore` take a client; the default HTTP implementation below
 * speaks the `refino web` API, and hosts (tool plugins, VSCode webview,
 * desktop) can supply their own transport-backed implementation.
 */
export interface RefinoClient {
  /** POST /api/query/neighbors — per-id bounded neighborhoods, nearest-first. */
  queryNeighbors(
    ids: readonly string[],
    params: { ancestorDepth: number; descendantDepth: number; limit?: number },
  ): Promise<QueryGroup<Neighborhood>[]>;

  /** POST /api/query/range — relationship and path nodes between two endpoints. */
  queryRange(focusId: string, clickedId: string, budget?: number): Promise<RangeResult>;

  /** POST /api/query/siblings — per-id strong siblings by shared direct grounds. */
  querySiblings(ids: readonly string[], limit?: number): Promise<QueryGroup<SiblingSet>[]>;

  /** GET /api/search — keyset-paginated id/summary search. `unreferenced`
   * restricts premises no constraint grounds on; `roots` to root
   * constraints. */
  search(params: {
    q?: string;
    type?: "premise" | "constraint";
    limit?: number;
    cursor?: string;
    roots?: boolean;
    unreferenced?: boolean;
  }): Promise<SearchPage>;

  /** GET /api/nodes/:id — one full node (body on demand). */
  fetchNode(id: string): Promise<NodeDetail>;

  /** GET /api/validate — the current issues and revision. */
  fetchIssues(): Promise<{ ok: boolean; issues: IssueRecord[]; revision: number }>;

  /** GET /api/stats — counts for the project-overview cold start. */
  fetchStats(): Promise<{
    revision: number;
    nodes: number;
    constraints: number;
    premises: number;
    roots: number;
  }>;

  /** GET /api/pending — constraints pending review since the last reload. */
  fetchPending(): Promise<{ revision: number; nodes: SearchNode[] }>;

  /** POST /api/reload — authoritative full rescan. */
  reloadGraph(): Promise<ChangeEvent>;

  /** POST /api/nodes/:type — create a node. */
  createNode(type: "premise" | "constraint", payload: NodePayload): Promise<{ id: string }>;

  /** PUT /api/nodes/:id — `revision` turns the save into an optimistic
   * concurrency check (409 on mismatch); see docs/design.md, "编辑冲突处理". */
  updateNode(id: string, payload: NodePayload, revision?: number): Promise<{ id: string }>;

  /** DELETE /api/nodes/:id. */
  deleteNode(id: string): Promise<{ id: string }>;

  /**
   * Subscribe to the SSE change feed (`/api/events`). Returns a close
   * function. Degrades to a no-op subscription (never opens) where
   * EventSource is unavailable, e.g. non-browser test environments.
   */
  connectEvents(
    onEvent: (event: ChangeEvent) => void,
    onStatus?: (connected: boolean) => void,
  ): () => void;
}

/** Error responses are `{ error, ... }`; the message is thrown so callers
 * can surface it directly. Batch queries keep the engine's partial-success
 * shape: HTTP 207 carries per-id error groups in the body. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const payload: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const message =
      typeof payload === "object" && payload !== null && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return payload as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}

/** The default client over the `refino web` backend served on the same
 * origin (dev setups proxy `/api/*` to it). */
export function createHttpClient(): RefinoClient {
  return {
    queryNeighbors: (ids, params) => post("/api/query/neighbors", { ids: [...ids], ...params }),
    queryRange: (focusId, clickedId, budget) =>
      post("/api/query/range", { focusId, clickedId, budget }),
    querySiblings: (ids, limit) => post("/api/query/siblings", { ids: [...ids], limit }),
    search: (params) => {
      const query = new URLSearchParams();
      if (params.q) query.set("q", params.q);
      if (params.type) query.set("type", params.type);
      if (params.limit !== undefined) query.set("limit", String(params.limit));
      if (params.cursor !== undefined) query.set("cursor", params.cursor);
      if (params.roots === true) query.set("roots", "1");
      if (params.unreferenced === true) query.set("unreferenced", "1");
      const qs = query.toString();
      return request(`/api/search${qs === "" ? "" : `?${qs}`}`);
    },
    fetchNode: (id) => request(`/api/nodes/${id}`),
    fetchIssues: () => request("/api/validate"),
    fetchStats: () => request("/api/stats"),
    fetchPending: () => request("/api/pending"),
    reloadGraph: () => request("/api/reload", { method: "POST" }),
    createNode: (type, payload) => post(`/api/nodes/${type}`, payload),
    updateNode: (id, payload, revision) =>
      request(`/api/nodes/${id}`, {
        method: "PUT",
        body: JSON.stringify(revision === undefined ? payload : { ...payload, revision }),
      }),
    deleteNode: (id) => request(`/api/nodes/${id}`, { method: "DELETE" }),
    connectEvents: (onEvent, onStatus) => {
      if (typeof EventSource === "undefined") return () => undefined;
      const source = new EventSource("/api/events");
      source.onopen = () => onStatus?.(true);
      source.onerror = () => onStatus?.(false);
      source.onmessage = (event: MessageEvent<string>) => {
        try {
          onEvent(JSON.parse(event.data) as ChangeEvent);
        } catch {
          // A malformed frame is not worth tearing down the stream over.
        }
      };
      return () => source.close();
    },
  };
}

/** Provided by the embedding root (see main.ts); components inject it. */
export const clientKey: InjectionKey<RefinoClient> = Symbol("refino-client");
