import type { GraphRecord, NodePayload } from "./types";

/**
 * Thin JSON API client. Error responses are `{ error, ... }`; the message is
 * thrown so callers can surface it directly.
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

export function fetchGraph(): Promise<GraphRecord> {
  return request<GraphRecord>("/api/graph");
}

export function createNode(
  type: "premise" | "constraint",
  payload: NodePayload,
): Promise<{ id: string }> {
  return request<{ id: string }>(`/api/nodes/${type}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateNode(id: string, payload: NodePayload): Promise<{ id: string }> {
  return request<{ id: string }>(`/api/nodes/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteNode(id: string): Promise<{ id: string }> {
  return request<{ id: string }>(`/api/nodes/${id}`, { method: "DELETE" });
}
