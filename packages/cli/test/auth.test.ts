import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  A1,
  D4,
  P1,
  Z9,
  clearOrchestratorCredential,
  root,
  run,
  useOrchestratorCredential,
} from "./authorization-fixture.js";
import { workspaceStatePath } from "../src/authorization.js";

async function readStateJson(): Promise<unknown> {
  const dir = join(process.env.REFINO_HOME!, "workspaces");
  const files = await readdir(dir);
  expect(files.length).toBeGreaterThan(0);
  return JSON.parse(await readFile(join(dir, files[0]!), "utf8"));
}

describe("refino auth", () => {
  it("show reports the materialized default when nothing is signed", async () => {
    const { code, out } = await run(["--root", root(), "auth", "show"]);
    expect(code).toBe(0);
    expect(out).toContain("授权来源：默认");
    expect(out).toContain("revision：0");
    expect(out).toContain(`冻结 frontier：${A1}, ${Z9}`);
  });

  it("apply --dry-run previews without writing any state", async () => {
    const { code, out } = await run([
      "--root",
      root(),
      "auth",
      "apply",
      "--dry-run",
      "--frozen-frontier",
      D4,
    ]);
    expect(code).toBe(0);
    expect(out).toContain("预演（未写入）：revision 将为 1");
    // Zone of D4: D4 + P1 + A1.
    expect(out).toContain("- 冻结区：2 个约束、1 个前提");
    // The standalone root stays outside: loud warning.
    expect(out).toContain("根约束将解冻");
    expect(out).toContain(Z9);
    expect(out).toContain("确认后去掉 --dry-run");
    await expect(stat(join(process.env.REFINO_HOME!, "workspaces"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("apply signs the workspace state and show reflects it", async () => {
    const { code, out } = await run(["--root", root(), "auth", "apply", "--frozen-frontier", D4]);
    expect(code).toBe(0);
    expect(out).toContain("已签发 revision 1");
    expect(out).toContain("根约束将解冻");

    const state = (await readStateJson()) as {
      current: { revision: number; frozenFrontier: string[] };
      history: Array<{ revision: number }>;
    };
    expect(state.current.revision).toBe(1);
    expect(state.current.frozenFrontier).toEqual([D4]);
    // First signing seeds the history with the implicit default (revision 0)
    // so "context --since 0" can diff against it.
    expect(state.history).toHaveLength(1);
    expect(state.history[0]!.revision).toBe(0);

    const show = await run(["--root", root(), "auth", "show"]);
    expect(show.out).toContain("授权来源：工作区签发");
    expect(show.out).toContain("revision：1");
  });

  it("apply enforces optimistic concurrency via --expect-revision", async () => {
    const conflict = await run([
      "--root",
      root(),
      "auth",
      "apply",
      "--frozen-frontier",
      D4,
      "--expect-revision",
      "0",
    ]);
    expect(conflict.code).toBe(1);
    expect(conflict.err).toContain("authorization revision conflict: expected 0 but current is 1");

    const ok = await run([
      "--root",
      root(),
      "auth",
      "apply",
      "--frozen-frontier",
      A1,
      "--expect-revision",
      "1",
    ]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("已签发 revision 2");
  });

  it("apply rejects drafts that name unknown or non-constraint frontier nodes", async () => {
    const unknown = await run(["--root", root(), "auth", "apply", "--frozen-frontier", "9M8N7P6Q"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("Unknown node ids");

    const premiseFrontier = await run(["--root", root(), "auth", "apply", "--frozen-frontier", P1]);
    expect(premiseFrontier.code).toBe(1);
    expect(premiseFrontier.err).toContain("must reference constraint nodes");
  });

  it("apply refuses when an orchestrator credential is active", async () => {
    await useOrchestratorCredential([]);
    try {
      const { code, err } = await run(["--root", root(), "auth", "apply", "--frozen-frontier", D4]);
      expect(code).toBe(1);
      expect(err).toContain("orchestrator credential");
    } finally {
      clearOrchestratorCredential();
    }
  });

  it("context --since reports signing deltas and no-change states", async () => {
    // Current revision is 2 (frontier A1); revision 1 had frontier D4.
    const delta = await run(["--root", root(), "context", "--since", "1"]);
    expect(delta.code).toBe(0);
    expect(delta.out).toContain("授权上下文增量（revision 1 → 2）");
    expect(delta.out).toContain("frozen_removed D4E5F6G7");

    const unchanged = await run(["--root", root(), "context", "--since", "2"]);
    expect(unchanged.code).toBe(0);
    expect(unchanged.out).toContain("授权上下文自 revision 2 以来未变化");

    // Revision 0 is the seeded implicit default: anchors were dropped and
    // the other root left the zone.
    const fromDefault = await run(["--root", root(), "context", "--since", "0"]);
    expect(fromDefault.code).toBe(0);
    expect(fromDefault.out).toContain("授权上下文增量（revision 0 → 2）");
    expect(fromDefault.out).toContain("anchor_removed");
    expect(fromDefault.out).toContain("frozen_removed");

    const json = await run(["--root", root(), "--json", "context", "--since", "1"]);
    const payload = JSON.parse(json.out) as {
      changed: boolean;
      revision: number;
      delta: Array<{ type: string; id: string }>;
    };
    expect(payload.changed).toBe(true);
    expect(payload.revision).toBe(2);
    expect(payload.delta).toContainEqual({ type: "frozen_removed", id: D4 });
  });

  it("reset removes the signing and returns to the default", async () => {
    const { code, out } = await run(["--root", root(), "auth", "reset"]);
    expect(code).toBe(0);
    expect(out).toContain("已移除工作区签发");
    await expect(readdir(join(process.env.REFINO_HOME!, "workspaces"))).resolves.toEqual([]);

    const show = await run(["--root", root(), "auth", "show"]);
    expect(show.out).toContain("授权来源：默认");

    const again = await run(["--root", root(), "auth", "reset"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("无工作区签发");
  });

  it("reports a clear recovery hint for a malformed state file", async () => {
    const statePath = workspaceStatePath(root());
    await mkdir(join(statePath, ".."), { recursive: true });
    await writeFile(statePath, "not json", "utf8");
    try {
      const { code, err } = await run(["--root", root(), "auth", "show"]);
      expect(code).toBe(1);
      expect(err).toContain("not valid JSON");
      expect(err).toContain("auth reset");
    } finally {
      await rm(statePath, { force: true });
    }
  });
});
