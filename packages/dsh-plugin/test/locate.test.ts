import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findRefinoDir } from "../src/locate.js";

const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await rm(cleanup.pop()!, { recursive: true, force: true });
  }
});

async function tempRoot(withRefino: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "refino-locate-"));
  cleanup.push(root);
  if (withRefino) await mkdir(join(root, ".refino"), { recursive: true });
  return root;
}

describe("findRefinoDir", () => {
  it("finds the .refino directory of the cwd itself", async () => {
    const root = await tempRoot(true);
    expect(await findRefinoDir(root)).toBe(join(root, ".refino"));
  });

  it("walks up to the nearest ancestor with a .refino directory", async () => {
    const root = await tempRoot(true);
    const deep = join(root, "a", "b");
    expect(await findRefinoDir(deep)).toBe(join(root, ".refino"));
  });

  it("returns undefined when no ancestor has a .refino directory", async () => {
    const root = await tempRoot(false);
    expect(await findRefinoDir(root)).toBeUndefined();
  });
});
