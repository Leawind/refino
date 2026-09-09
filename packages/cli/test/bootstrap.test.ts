import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/main.js";
import type { CliIo } from "../src/format.js";

/**
 * Adoption: `refino init` scaffolds the bare skeleton; an existing .refino/
 * is refused so an adopted repository is never mistaken for a fresh one.
 */

let bareRoot: string;

beforeAll(async () => {
  bareRoot = await mkdtemp(join(tmpdir(), "refino-bare-"));
});

afterAll(async () => {
  await rm(bareRoot, { recursive: true, force: true });
});

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (text: string) => void out.push(text) },
    stderr: { write: (text: string) => void err.push(text) },
  };
  const code = await main(argv, io);
  return { code, out: out.join(""), err: err.join("") };
}

describe("refino init", () => {
  it("creates the skeleton and refuses an existing .refino", async () => {
    const { code, out } = await run(["--root", bareRoot, "init"]);
    expect(code).toBe(0);
    expect(out).toContain("initialized");
    // The skeleton is the nodes/ graph directory; the CRG starts empty.
    expect(() => mkdirSync(join(bareRoot, ".refino", "nodes"))).toThrow(/EEXIST/);

    const again = await run(["--root", bareRoot, "init"]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("already exists");
  });
});
