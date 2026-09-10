import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/main.js";
import type { CliIo } from "../src/format.js";

/**
 * Adoption and self-documentation: `refino init` scaffolds the bare
 * skeleton; `refino guide` teaches an agent the tool with no other context.
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

describe("refino guide", () => {
  it("prints the full working protocol without requiring an adopted repository", async () => {
    // Self-documentation is exempt from the adoption contract: it must work
    // in a bare directory, where an agent first encounters the tool.
    const { code, out } = await run(["guide"]);
    expect(code).toBe(0);
    expect(out).toContain("# refino 使用指南");
    expect(out).toContain("约束（constraint）");
    expect(out).toContain("前提（premise）");
    expect(out).toContain("硬规则");
    expect(out).toContain("refino init");
    // Commands are not listed; --help owns that.
    expect(out).not.toContain("`delete");
  });

  it("is discoverable from --help", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("refino guide");
  });
});
