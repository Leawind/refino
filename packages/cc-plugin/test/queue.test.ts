import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";
import { drainUpdate, enqueueUpdate, peekUpdate } from "../src/queue.js";

/** Queue keys are arbitrary strings; distinct fake dirs give distinct queues. */
const KEYS = ["/refino-cc-test/alpha", "/refino-cc-test/beta"];
/** The `.refino` dir of a fixture project — the real-world key. */
let fixtureRefino: string | undefined;

afterEach(async () => {
  for (const key of KEYS) await drainUpdate(key); // clean the shared tmpdir
  if (fixtureRefino !== undefined) {
    await drainUpdate(fixtureRefino);
    fixtureRefino = undefined;
  }
});

describe("injection queue", () => {
  it("round-trips one update and clears on drain", async () => {
    await enqueueUpdate(KEYS[0], "update one");
    expect(await peekUpdate(KEYS[0])).toBe("update one");
    expect(await drainUpdate(KEYS[0])).toBe("update one");
    expect(await peekUpdate(KEYS[0])).toBeUndefined();
    expect(await drainUpdate(KEYS[0])).toBeUndefined();
  });

  it("merges pending texts instead of replacing them", async () => {
    await enqueueUpdate(KEYS[0], "first");
    await enqueueUpdate(KEYS[0], "second");
    expect(await peekUpdate(KEYS[0])).toBe("first\n\nsecond");
  });

  it("drops an identical re-enqueue (identical-text guard at the queue)", async () => {
    await enqueueUpdate(KEYS[0], "same");
    await enqueueUpdate(KEYS[0], "same");
    expect(await peekUpdate(KEYS[0])).toBe("same");
  });

  it("keeps keys isolated and treats a missing queue as empty", async () => {
    await enqueueUpdate(KEYS[0], "only alpha");
    expect(await peekUpdate(KEYS[1])).toBeUndefined();
    expect(await peekUpdate("/refino-cc-test/never-written")).toBeUndefined();
  });

  it("is keyed by the .refino directory of a real project layout", async () => {
    const root = await createRefino({
      "nodes/P1/PREMISE-premise.md": premise("P1PREMISE", "事实一"),
      "nodes/R1/ROOT-constraint.md": constraint("R1ROOT", undefined, "根约束"),
    });
    try {
      const refinoDir = join(root, ".refino");
      fixtureRefino = refinoDir;
      await enqueueUpdate(refinoDir, "external change");
      expect(await drainUpdate(refinoDir)).toBe("external change");
    } finally {
      await removeRefino(root);
    }
  });
});
