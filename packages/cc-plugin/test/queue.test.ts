import { afterEach, describe, expect, it } from "vitest";
import {
  bindSession,
  drainUpdate,
  enqueueUpdate,
  peekUpdate,
  SESSION_TOKEN_RE,
  sessionStamp,
  sessionToken,
} from "../src/queue.js";

/** Queue keys are server tokens; distinct tokens give distinct queues. */
const TOKENS = ["aaaaaaaa01", "bbbbbbbb02"];
const SESSIONS = ["sess-alpha-1", "sess-beta-2"];

afterEach(async () => {
  for (const token of TOKENS) await drainUpdate(token); // clean the shared tmpdir
});

describe("injection queue", () => {
  it("round-trips one update and clears on drain", async () => {
    await enqueueUpdate(TOKENS[0]!, "update one");
    expect(await peekUpdate(TOKENS[0]!)).toBe("update one");
    expect(await drainUpdate(TOKENS[0]!)).toBe("update one");
    expect(await peekUpdate(TOKENS[0]!)).toBeUndefined();
    expect(await drainUpdate(TOKENS[0]!)).toBeUndefined();
  });

  it("merges pending texts instead of replacing them", async () => {
    await enqueueUpdate(TOKENS[0]!, "first");
    await enqueueUpdate(TOKENS[0]!, "second");
    expect(await peekUpdate(TOKENS[0]!)).toBe("first\n\nsecond");
  });

  it("drops an identical re-enqueue (identical-text guard at the queue)", async () => {
    await enqueueUpdate(TOKENS[0]!, "same");
    await enqueueUpdate(TOKENS[0]!, "same");
    expect(await peekUpdate(TOKENS[0]!)).toBe("same");
  });

  it("keeps tokens isolated and treats a missing queue as empty", async () => {
    await enqueueUpdate(TOKENS[0]!, "only alpha");
    expect(await peekUpdate(TOKENS[1]!)).toBeUndefined();
    expect(await peekUpdate("cccccccc03")).toBeUndefined();
  });
});

describe("session binding", () => {
  it("binds a session to a stamped token and rebinds on overwrite", async () => {
    await bindSession(SESSIONS[0]!, TOKENS[0]!);
    expect(await sessionToken(SESSIONS[0]!)).toBe(TOKENS[0]!);
    // A server restart hands the session a new token; the binding follows.
    await bindSession(SESSIONS[0]!, TOKENS[1]!);
    expect(await sessionToken(SESSIONS[0]!)).toBe(TOKENS[1]!);
    expect(await sessionToken(SESSIONS[1]!)).toBeUndefined();
  });

  it("captures the stamp from a raw payload regardless of tool_response shape", () => {
    const token = "c0ffee00";
    const raw = JSON.stringify({
      session_id: SESSIONS[0]!,
      hook_event_name: "PostToolUse",
      tool_response: {
        content: [{ type: "text", text: `result text\n${sessionStamp(token)}` }],
      },
    });
    expect(SESSION_TOKEN_RE.exec(raw)?.[1]).toBe(token);
  });

  it("rejects session ids that are not filename-safe", async () => {
    expect(await bindSession("../escape", TOKENS[0]!)).toBe(false);
    expect(await bindSession("with/slash", TOKENS[0]!)).toBe(false);
    expect(await bindSession("with space", TOKENS[0]!)).toBe(false);
    expect(await sessionToken("../escape")).toBeUndefined();
  });
});
