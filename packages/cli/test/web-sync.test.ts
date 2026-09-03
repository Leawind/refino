import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWebServer } from "../src/web/server.js";
import type { RunningWebServer } from "../src/web/server.js";
import { createConstraint } from "@refino/storage";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";

/**
 * External-change synchronization end to end (docs/design.md, "外部变更同步"):
 * the sharded-directory watcher feeds the index's unified update entry and
 * the resulting revision events reach SSE clients. API-originated writes are
 * broadcast through the same entry.
 */

const P1 = "1A2B3C4D";

interface ChangeEvent {
  revision: number;
  changed: string[];
  deleted: string[];
  reload?: boolean;
}

let root: string;
let refinoDir: string;
let running: RunningWebServer;

beforeAll(async () => {
  root = await createRefino({
    "nodes/1A/2B3C4D.premise.md": premise(P1, "前提一。"),
    "nodes/A1/B2C3D4.constraint.md": constraint("A1B2C3D4", [P1], "C1。"),
  });
  refinoDir = join(root, ".refino");
  running = await startWebServer({
    host: "127.0.0.1",
    port: 0,
    refinoDir,
    watchDebounceMs: 50,
  });
  // inotify watchers arm on the next loop ticks; writes before that are
  // only visible via reload, so tests wait for the watcher to be live.
  await new Promise((resolve) => setTimeout(resolve, 150));
}, 20_000);

afterAll(async () => {
  running.server.closeAllConnections?.();
  await new Promise<void>((resolve) => running.server.close(() => resolve()));
  await removeRefino(root);
});

/** Reads the next SSE data event, failing after 5s of silence. */
async function readEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffer: { text: string },
): Promise<ChangeEvent> {
  const decoder = new TextDecoder();
  for (;;) {
    const boundary = buffer.text.indexOf("\n\n");
    if (boundary !== -1) {
      const frame = buffer.text.slice(0, boundary);
      buffer.text = buffer.text.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
        .join("\n");
      return JSON.parse(data) as ChangeEvent;
    }
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("SSE read timeout")), 5000);
        timer.unref?.();
      }),
    ]);
    if (chunk.done) throw new Error("SSE stream ended unexpectedly");
    buffer.text += decoder.decode(chunk.value, { stream: true });
  }
}

describe("external change sync", () => {
  it("pushes revision events for API writes and external file writes alike", async () => {
    const res = await fetch(`${running.url}/api/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const buffer = { text: "" };

    // Baseline snapshot with the current revision.
    const snapshot = await readEvent(reader, buffer);
    expect(snapshot).toEqual({ revision: 1, changed: [], deleted: [], reload: true });

    // API-originated write: broadcast through the unified update entry.
    const created = await fetch(`${running.url}/api/nodes/constraint`, {
      method: "POST",
      body: JSON.stringify({ body: "API 写入。", grounds: [P1] }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const apiEvent = await readEvent(reader, buffer);
    expect(apiEvent).toEqual({ revision: 2, changed: [id], deleted: [] });

    // External write straight to `.refino/` (as tool plugins do): the
    // watcher detects it, the index applies it, SSE carries it.
    const externalId = await createConstraint(refinoDir, { body: "外部写入。", grounds: [P1] });
    const externalEvent = await readEvent(reader, buffer);
    expect(externalEvent).toEqual({ revision: 3, changed: [externalId], deleted: [] });

    // The on-demand API reflects the external write without any reload.
    const queried = await fetch(`${running.url}/api/query/grounds`, {
      method: "POST",
      body: JSON.stringify({ ids: [externalId] }),
    });
    const groups = (await queried.json()) as Array<{ id: string; results: Array<{ id: string }> }>;
    expect(groups[0]!.results.map((n) => n.id)).toEqual([P1]);

    reader.cancel();
  }, 15_000);
});
