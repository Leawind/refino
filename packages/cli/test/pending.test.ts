import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { constraint, premise } from "@refino/testkit";
import { main } from "../src/main.js";
import type { CliIo } from "../src/format.js";

/**
 * `refino pending`: git-derived modified nodes plus the downstream
 * pending-review closure (docs/crg.md 1.6). Runs against a real throwaway
 * git repository — the command shells out to git by design.
 */

const P1 = "1A2B3C4D";
const A1 = "A1B2C3D4";
const D4 = "D4E5F6G7";

const exec = promisify(execFile);
let home: string;
let repo: string;
let bare: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "refino-pending-home-"));
  process.env.REFINO_HOME = home;

  repo = await mkdtemp(join(tmpdir(), "refino-pending-repo-"));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "test"]);
  await writeNode(repo, "1A/2B3C4D-premise.md", premise(P1, "PostgreSQL 16 is in use."));
  await writeNode(
    repo,
    "A1/B2C3D4-constraint.md",
    constraint(A1, undefined, "All data lives in PostgreSQL."),
  );
  await writeNode(
    repo,
    "D4/E5F6G7-constraint.md",
    constraint(D4, [P1, A1], "Access goes through repositories."),
  );
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "baseline"]);

  bare = await mkdtemp(join(tmpdir(), "refino-pending-bare-"));
  await writeNode(bare, "1A/2B3C4D-premise.md", premise(P1, "PostgreSQL 16 is in use."));
});

afterAll(async () => {
  for (const dir of [home, repo, bare]) await rm(dir, { recursive: true, force: true });
  delete process.env.REFINO_HOME;
});

function git(root: string, args: string[]): Promise<unknown> {
  return exec("git", ["-C", root, ...args]);
}

async function writeNode(root: string, file: string, content: string): Promise<void> {
  const path = join(root, ".refino", "nodes", file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (text: string) => void out.push(text) },
    stderr: { write: (text: string) => void err.push(text) },
  };
  const code = await main(["--root", repo, ...argv], io);
  return { code, out: out.join(""), err: err.join("") };
}

describe("refino pending", () => {
  it("reports uncommitted premise changes and the downstream pending closure", async () => {
    await appendNode(repo, "1A/2B3C4D-premise.md", "\nEdited.\n");
    const { code, out } = await run(["pending"]);
    expect(code).toBe(0);
    expect(out).toContain("基线：HEAD");
    expect(out).toContain(`已修改节点（1 个）：${P1}`);
    // D4 grounds on the changed premise: it must be reviewed.
    expect(out).toContain(`- ${D4} [constraint] depth 1`);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "edit premise"]);
  });

  it("supports an explicit --base beyond the last commit", async () => {
    const { code, out } = await run(["pending", "--base", "HEAD~1"]);
    expect(code).toBe(0);
    expect(out).toContain(`已修改节点（1 个）：${P1}`);
    expect(out).toContain(D4);

    const clean = await run(["pending"]);
    expect(clean.out).toContain("已修改节点（0 个）：无");
  });

  it("emits structured JSON", async () => {
    await appendNode(repo, "A1/B2C3D4-constraint.md", "\nEdited.\n");
    const { code, out } = await run(["--json", "pending"]);
    expect(code).toBe(0);
    const payload = JSON.parse(out) as {
      base: string;
      modified: string[];
      pending: Array<{ id: string; type: string; depth: number }>;
    };
    expect(payload.base).toBe("HEAD");
    expect(payload.modified).toEqual([A1]);
    expect(payload.pending).toEqual([
      { id: D4, type: "constraint", depth: 1, summary: expect.any(String) },
    ]);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "edit constraint"]);
  });

  it("maps deleted nodes back to ids", async () => {
    // Deleting a constraint nobody depends on keeps the graph valid, so the
    // command can run; the deleted file still shows up as a change.
    await rm(join(repo, ".refino", "nodes", "D4", "E5F6G7-constraint.md"));
    const { code, out } = await run(["pending"]);
    expect(code).toBe(0);
    expect(out).toContain(`已修改节点（1 个）：${D4}`);
    expect(out).toContain("无待审查约束。");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "delete D4"]);
  });

  it("refuses a repository outside git with a fallback hint", async () => {
    const err: string[] = [];
    const code = await main(["--root", bare, "pending"], {
      stdout: { write: () => undefined },
      stderr: { write: (text: string) => void err.push(text) },
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("not inside a git work tree");
    expect(err.join("")).toContain("refino dependents");
  });
});

async function appendNode(root: string, file: string, extra: string): Promise<void> {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(join(root, ".refino", "nodes", file), extra);
}
