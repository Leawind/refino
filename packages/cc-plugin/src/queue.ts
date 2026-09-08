import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The cross-process injection queue (docs/design.md, cc-plugin 落地形态):
 * the MCP server (long-lived, one per session) renders external-change
 * updates and signing deltas; the UserPromptSubmit / PostToolUse hooks
 * (one-shot per event) drain the queue and inject the text. The host offers
 * no in-process channel between a plugin MCP server and the conversation,
 * so the tmpdir file is the delivery lane — machine-local, outside every
 * repository, holding nothing but undelivered update text (never signing
 * state). The OS reclaims abandoned files together with the temp directory.
 *
 * The queue is PER SESSION, keyed by the server's random session token:
 * concurrent sessions over one repo hold different known sets, so their
 * update texts must not cross. Session归属 is established by a token
 * handshake — the server stamps `refino-session:<token>` on every tool
 * result, the host copies the response into that session's PostToolUse
 * payload, and the sync hook records session_id → token here (the only
 * race-free correlation channel: the stamp rides the response to exactly
 * the session that requested it).
 */

const QUEUE_DIR = join(tmpdir(), "refino-cc");
const SESSIONS_DIR = join(QUEUE_DIR, "sessions");

/** The trailing line every refino tool result carries (the handshake stamp). */
export function sessionStamp(token: string): string {
  return `refino-session:${token}`;
}

/** Token capture over a raw hook payload; shape-agnostic over tool_response. */
export const SESSION_TOKEN_RE = /refino-session:([A-Za-z0-9]{8,64})/;

export function queueFile(token: string): string {
  return join(QUEUE_DIR, `${token}.json`);
}

/**
 * Session ids are host-controlled strings; restrict them to a filename-safe
 * alphabet (no dots, no separators) so a hostile id cannot traverse.
 */
function sessionFile(sessionId: string): string | undefined {
  return /^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ? join(SESSIONS_DIR, sessionId) : undefined;
}

/** Record the session→token binding discovered from a stamped tool response. */
export async function bindSession(sessionId: string, token: string): Promise<boolean> {
  const file = sessionFile(sessionId);
  if (file === undefined) return false;
  await mkdir(SESSIONS_DIR, { recursive: true });
  // Atomic write: a concurrent reader sees the old or the new file, never a
  // torn one (same discipline as the storage layer's node writes).
  const staging = `${file}.${process.pid}.tmp`;
  await writeFile(staging, token, "utf8");
  await rename(staging, file);
  return true;
}

/** The token bound to a session, if any; undefined when nothing is bound. */
export async function sessionToken(sessionId: string): Promise<string | undefined> {
  const file = sessionFile(sessionId);
  if (file === undefined) return undefined;
  try {
    return (await readFile(file, "utf8")).trim();
  } catch {
    return undefined; // missing or unreadable: nothing bound
  }
}

/** Queue one update text for a session token; texts merge, identical ones dedupe. */
export async function enqueueUpdate(token: string, text: string): Promise<void> {
  // Chunks never contain blank lines (update texts are single-block frames),
  // so a double newline separates queued chunks unambiguously.
  const chunks = (await peekUpdate(token))?.split("\n\n") ?? [];
  if (chunks.includes(text)) return; // identical-text guard: zero new information
  chunks.push(text);
  const file = queueFile(token);
  await mkdir(QUEUE_DIR, { recursive: true });
  // Atomic write: a concurrent reader sees the old or the new file, never a
  // torn one (same discipline as the storage layer's node writes).
  const staging = `${file}.${process.pid}.tmp`;
  await writeFile(staging, JSON.stringify({ text: chunks.join("\n\n") }), "utf8");
  await rename(staging, file);
}

/** The queued text without consuming it; undefined when nothing is pending. */
export async function peekUpdate(token: string): Promise<string | undefined> {
  try {
    const raw = await readFile(queueFile(token), "utf8");
    const parsed = JSON.parse(raw) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : undefined;
  } catch {
    return undefined; // missing or unreadable: nothing pending
  }
}

/** Consume the queued text; undefined when nothing is pending. */
export async function drainUpdate(token: string): Promise<string | undefined> {
  const text = await peekUpdate(token);
  if (text === undefined) return undefined;
  await unlink(queueFile(token)).catch(() => {});
  return text;
}
