import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { workspaceStatePath } from "../src/authorization.js";

/**
 * Workspace state keying (docs/design.md, "授权状态的作用域"): one
 * repository maps to one state file no matter which path variant reaches it.
 */
describe("workspaceStatePath", () => {
  const dirs: string[] = [];

  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it("keys a symlinked root to the same state file as the real path", async () => {
    const real = await mkdtemp(join(tmpdir(), "refino-ws-real-"));
    const parent = await mkdtemp(join(tmpdir(), "refino-ws-parent-"));
    dirs.push(real, parent);
    const link = join(parent, "link");
    await symlink(real, link);

    const env = { REFINO_HOME: join(parent, "home") };
    expect(workspaceStatePath(link, env)).toBe(workspaceStatePath(real, env));
  });

  it("distinct repositories key to distinct state files", async () => {
    const a = await mkdtemp(join(tmpdir(), "refino-ws-a-"));
    const b = await mkdtemp(join(tmpdir(), "refino-ws-b-"));
    dirs.push(a, b);
    const env = { REFINO_HOME: join(a, "home") };

    expect(workspaceStatePath(a, env)).not.toBe(workspaceStatePath(b, env));
  });

  it("does not throw for a nonexistent root", () => {
    const path = workspaceStatePath("/definitely/not/here", { REFINO_HOME: "/tmp/refino-ws-home" });
    expect(path).toMatch(/[/\\]workspaces[/\\][0-9a-f]{16}\.json$/);
  });
});
