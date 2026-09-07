import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { workspaceStatePath } from "../src/authorization.js";
import { ensureStateIgnored } from "../src/commands/init.js";

/**
 * The state lane is workspace-scoped (docs/design.md, "授权状态的作用域"):
 * the state file lives inside the repository's own `.refino/state/`, kept
 * out of version control by the `.refino/.gitignore` seeded once at
 * `refino init`. The write path never manages that file — a user removing
 * the rule (upper-level ignore management, or deliberate versioning of
 * `state/`) has the last word. This lane belongs to the generic skill+CLI
 * form; the plugin form keeps its signings in session memory instead.
 */
describe("workspace state lane", () => {
  const dirs: string[] = [];

  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it("places the state file in the workspace's own .refino/state/", () => {
    expect(workspaceStatePath("/some/repo")).toMatch(/[/\\]\.refino[/\\]state[/\\]current\.json$/);
  });

  it("ensureStateIgnored creates the gitignore when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refino-state-a-"));
    dirs.push(dir);
    await ensureStateIgnored(dir);
    const content = await readFile(join(dir, ".gitignore"), "utf8");
    expect(content).toContain("/state/");
  });

  it("ensureStateIgnored leaves an existing rule untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refino-state-b-"));
    dirs.push(dir);
    const file = join(dir, ".gitignore");
    await writeFile(file, "/state/\n", "utf8");
    await ensureStateIgnored(dir);
    expect(await readFile(file, "utf8")).toBe("/state/\n");
  });

  it("ensureStateIgnored appends the rule to a foreign gitignore", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refino-state-c-"));
    dirs.push(dir);
    const file = join(dir, ".gitignore");
    await writeFile(file, "notes.txt", "utf8");
    await ensureStateIgnored(dir);
    const content = await readFile(file, "utf8");
    expect(content).toContain("notes.txt");
    expect(content).toContain("/state/");
  });
});
