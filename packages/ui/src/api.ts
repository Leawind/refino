import type {
  ChangeEvent,
  IssueRecord,
  Neighborhood,
  NodeDetail,
  NodeLite,
  NodePayload,
  QueryGroup,
  RangeResult,
  SearchPage,
  SiblingSet,
} from "./types";

/**
 * Thin JSON API client over the backend contract (docs/design.md, "后端 API
 * 契约"). Error responses are `{ error, ... }`; the message is thrown so
 * callers can surface it directly. Batch queries keep the engine's
 * partial-success shape: HTTP 207 carries per-id error groups in the body.
 */

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

/** POST /api/query/neighbors — per-id bounded neighborhoods, nearest-first. */
export function queryNeighbors(
  ids: readonly string[],
  params: { ancestorDepth: number; descendantDepth: number; limit?: number },
): Promise<QueryGroup<Neighborhood>[]> {
  return post("/api/query/neighbors", { ids: [...ids], ...params });
}

/** POST /api/query/grounds — per-id direct grounds, single hop. */
export function queryGrounds(ids: readonly string[]): Promise<QueryGroup<NodeLite>[]> {
  return post("/api/query/grounds", { ids: [...ids] });
}

/** POST /api/query/range — relationship and path nodes between two endpoints. */
export function queryRange(
  focusId: string,
  clickedId: string,
  budget?: number,
): Promise<RangeResult> {
  return post("/api/query/range", { focusId, clickedId, budget });
}

/** POST /api/query/siblings — per-id strong siblings by shared direct grounds. */
export function querySiblings(
  ids: readonly string[],
  limit?: number,
): Promise<QueryGroup<SiblingSet>[]> {
  return post("/api/query/siblings", { ids: [...ids], limit });
}

/** GET /api/search — keyset-paginated id/summary search for sidebars and the
 * grounds selector. */
export function search(params: {
  q?: string;
  type?: "premise" | "constraint";
  limit?: number;
  cursor?: string;
}): Promise<SearchPage> {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.type) query.set("type", params.type);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.cursor !== undefined) query.set("cursor", params.cursor);
  const qs = query.toString();
  return request(`/api/search${qs === "" ? "" : `?${qs}`}`);
}

/** GET /api/nodes/:id — one full node (body on demand). */
export function fetchNode(id: string): Promise<NodeDetail> {
  return request(`/api/nodes/${id}`);
}

/** GET /api/validate — the current issues and revision. */
export function fetchIssues(): Promise<{ ok: boolean; issues: IssueRecord[]; revision: number }> {
  return request("/api/validate");
}

/** POST /api/reload — authoritative full rescan; the response is a reload
 * change event. */
export function reloadGraph(): Promise<ChangeEvent> {
  return request("/api/reload", { method: "POST" });
}

export function createNode(
  type: "premise" | "constraint",
  payload: NodePayload,
): Promise<{ id: string }> {
  return post(`/api/nodes/${type}`, payload);
}

/** PUT /api/nodes/:id — `revision` turns the save into an optimistic
 * concurrency check (409 on mismatch); see docs/design.md, "编辑冲突处理". */
export function updateNode(
  id: string,
  payload: NodePayload,
  revision?: number,
): Promise<{ id: string }> {
  return request(`/api/nodes/${id}`, {
    method: "PUT",
    body: JSON.stringify(revision === undefined ? payload : { ...payload, revision }),
  });
}

export function deleteNode(id: string): Promise<{ id: string }> {
  return request(`/api/nodes/${id}`, { method: "DELETE" });
}

/**
 * Subscribe to the SSE change feed (`/api/events`). Returns a close function.
 * Degrades to a no-op subscription (never opens) where EventSource is
 * unavailable, e.g. non-browser test environments.
 */
export function connectEvents(
  onEvent: (event: ChangeEvent) => void,
  onStatus?: (connected: boolean) => void,
): () => void {
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
}
