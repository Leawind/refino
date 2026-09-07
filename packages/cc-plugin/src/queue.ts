import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The cross-process injection queue (docs/design.md, cc-plugin 落地形态):
 * the MCP server (long-lived) renders external-change updates and signing
 * deltas; the UserPromptSubmit hook (one-shot per prompt) drains the queue
 * and injects the text. The host offers no in-process channel between a
 * plugin MCP server and the conversation, so the tmpdir file is the delivery
 * lane — machine-local, outside every repository, holding nothing but
 * undelivered update text (never signing state). The OS reclaims abandoned
 * files together with the temp directory.
 *
 * Keyed by the `.refino` directory path: both ends locate the same
 * directory from the project cwd, so concurrent sessions over one project
 * share one queue (each prompt drains what accumulated; a drained text
 * reaches the session that prompted first).
 */

const QUEUE_DIR = join(tmpdir(), "refino-cc");

function queueFile(refinoDir: string): string {
  const key = createHash("sha256").update(refinoDir).digest("hex").slice(0, 24);
  return join(QUEUE_DIR, `${key}.json`);
}

/** Queue one update text; texts pending delivery merge, identical ones dedupe. */
export async function enqueueUpdate(refinoDir: string, text: string): Promise<void> {
  // Chunks never contain blank lines (update texts are single-block frames),
  // so a double newline separates queued chunks unambiguously.
  const chunks = (await peekUpdate(refinoDir))?.split("\n\n") ?? [];
  if (chunks.includes(text)) return; // identical-text guard: zero new information
  chunks.push(text);
  const file = queueFile(refinoDir);
  await mkdir(QUEUE_DIR, { recursive: true });
  // Atomic write: a concurrent reader sees the old or the new file, never a
  // torn one (same discipline as the storage layer's node writes).
  const staging = `${file}.${process.pid}.tmp`;
  await writeFile(staging, JSON.stringify({ text: chunks.join("\n\n") }), "utf8");
  await rename(staging, file);
}

/** The queued text without consuming it; undefined when nothing is pending. */
export async function peekUpdate(refinoDir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(queueFile(refinoDir), "utf8");
    const parsed = JSON.parse(raw) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : undefined;
  } catch {
    return undefined; // missing or unreadable: nothing pending
  }
}

/** Consume the queued text; undefined when nothing is pending. */
export async function drainUpdate(refinoDir: string): Promise<string | undefined> {
  const text = await peekUpdate(refinoDir);
  if (text === undefined) return undefined;
  await unlink(queueFile(refinoDir)).catch(() => {});
  return text;
}
