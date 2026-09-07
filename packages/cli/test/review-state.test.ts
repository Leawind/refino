import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RefinoStore } from "@refino/storage";
import { constraint, premise } from "@refino/testkit";
import { ackEntries, readLedger, recordAffected, reviewStatePath } from "../src/review-state.js";
import { ensureStateIgnored } from "../src/commands/init.js";
import { main } from "../src/main.js";
import type { CliIo } from "../format.js";

/**
 * The review ledger is the workspace state lane of the generic skill+CLI
 * form (docs/design.md, "通用接入形态"): write commands record affected
 * downstream, humans resolve entries with `refino review ack`. The lane lives
 * inside the repository's own `.refino/state/`, kept out of version control
 * by the `.refino/.gitignore` seeded at `refino init`. Command-level tests
 * run against a real throwaway git repository — `pending` shells out to git
 * by design.
 */

const P1 = "1A2B3C4D";
const A1 = "A1B2C3D4";
const D4 = "D4E5F6G7";

const exec = promisify(execFile);
let repo: string;
const unitDirs: string[] = [];

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "refino-review-repo-"));
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
  // The committed gitignore keeps the state lane out of the test commits,
  // exactly as `refino init` would seed it.
  await mkdir(join(repo, ".refino"), { recursive: true });
  await writeFile(join(repo, ".refino", ".gitignore"), "/state/\n", "utf8");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "baseline"]);
});

afterAll(async () => {
  for (const dir of [repo, ...unitDirs]) await rm(dir, { recursive: true, force: true });
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

/** The repo's resident graph, for convergence checks. */
async function repoGraph() {
  const store = RefinoStore.open(join(repo, ".refino"));
  await store.ready();
  const graph = store.graph;
  store.close();
  return graph;
}

/** Start a test from a known-empty ledger. */
async function resetLedger(root: string): Promise<void> {
  await mkdir(dirname(reviewStatePath(root)), { recursive: true });
  await writeFile(reviewStatePath(root), JSON.stringify({ version: 1, pending: [] }), "utf8");
}

describe("state lane placement", () => {
  it("places the ledger in the workspace's own .refino/state/", () => {
    expect(reviewStatePath("/some/repo")).toMatch(/[/\\]\.refino[/\\]state[/\\]review\.json$/);
  });

  it("ensureStateIgnored creates the gitignore when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refino-state-a-"));
    unitDirs.push(dir);
    await ensureStateIgnored(dir);
    const content = await readFile(join(dir, ".gitignore"), "utf8");
    expect(content).toContain("/state/");
  });

  it("ensureStateIgnored leaves an existing rule untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refino-state-b-"));
    unitDirs.push(dir);
    const file = join(dir, ".gitignore");
    await writeFile(file, "/state/\n", "utf8");
    await ensureStateIgnored(dir);
    expect(await readFile(file, "utf8")).toBe("/state/\n");
  });

  it("ensureStateIgnored appends the rule to a foreign gitignore", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refino-state-c-"));
    unitDirs.push(dir);
    const file = join(dir, ".gitignore");
    await writeFile(file, "notes.txt", "utf8");
    await ensureStateIgnored(dir);
    const content = await readFile(file, "utf8");
    expect(content).toContain("notes.txt");
    expect(content).toContain("/state/");
  });
});

describe("ledger io", () => {
  it("records and reads back entries, deduped by id", async () => {
    await resetLedger(repo);
    await recordAffected(repo, [{ id: D4, source: P1, kind: "update" }]);
    let ledger = await readLedger(repo);
    expect(ledger.pending).toHaveLength(1);
    expect(ledger.pending[0]).toMatchObject({ id: D4, source: P1, kind: "update" });

    // Re-recording refreshes the cause but keeps the earliest addedAt.
    const path = reviewStatePath(repo);
    const aged = JSON.parse(await readFile(path, "utf8")) as {
      pending: Array<{ addedAt: string }>;
    };
    aged.pending[0]!.addedAt = "2000-01-01T00:00:00.000Z";
    await writeFile(path, JSON.stringify(aged), "utf8");
    await recordAffected(repo, [{ id: D4, source: A1, kind: "delete" }]);
    ledger = await readLedger(repo);
    expect(ledger.pending).toHaveLength(1);
    expect(ledger.pending[0]).toMatchObject({
      id: D4,
      source: A1,
      kind: "delete",
      addedAt: "2000-01-01T00:00:00.000Z",
    });
  });

  it("converges entries whose node no longer exists", async () => {
    await resetLedger(repo);
    await recordAffected(repo, [{ id: D4, source: P1, kind: "update" }]);
    expect((await readLedger(repo)).pending).toHaveLength(1);
    const graph = await repoGraph();
    // D4 exists, so plain convergence keeps it; a dead id is dropped.
    await recordAffected(repo, [{ id: "ZZZZZZ99", source: P1, kind: "update" }]);
    expect((await readLedger(repo)).pending).toHaveLength(2);
    expect((await readLedger(repo, graph)).pending).toHaveLength(1);
  });

  it("ack removes entries and reports unknown ids", async () => {
    await resetLedger(repo);
    await recordAffected(repo, [{ id: D4, source: P1, kind: "update" }]);
    const missing = await ackEntries(repo, [D4, "ZZZZZZ99"]);
    expect(missing).toEqual(["ZZZZZZ99"]);
    expect((await readLedger(repo)).pending).toHaveLength(0);
  });

  it("rejects a malformed ledger with a reset hint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refino-review-bad-"));
    unitDirs.push(dir);
    await mkdir(join(dir, ".refino", "state"), { recursive: true });
    await writeFile(reviewStatePath(dir), "not json", "utf8");
    await expect(readLedger(dir)).rejects.toThrow("delete the file to reset");
  });
});

describe("review workflow through the cli", () => {
  it("update records affected downstream and reports them", async () => {
    const { code, out } = await run(["update", P1, "--body", "PostgreSQL 17 is in use."]);
    expect(code).toBe(0);
    expect(out).toContain(`updated ${P1}`);
    expect(out).toContain(`待审查（下游受影响，已记入审核台账）：${D4}`);
  });

  it("review lists ledger entries; pending merges them after the commit lands", async () => {
    const listed = await run(["review"]);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain("审核台账（1 项待审查");
    expect(listed.out).toContain(`- ${D4} [constraint] Access goes through repositories.`);

    const json = await run(["--json", "review"]);
    const payload = JSON.parse(json.out) as {
      pending: Array<{ id: string; source: string; kind: string; summary: string }>;
    };
    expect(payload.pending).toHaveLength(1);
    expect(payload.pending[0]).toMatchObject({ id: D4, source: P1, kind: "update" });

    // Once the change is committed, git-derived pending goes quiet while the
    // ledger keeps the review obligation alive.
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "edit premise"]);
    const pending = await run(["pending"]);
    expect(pending.out).toContain("已修改节点（0 个）：无");
    expect(pending.out).toContain("台账待审查");
    expect(pending.out).toContain(`- ${D4}（因 ${P1} 更新于`);
  });

  it("context carries the pending count", async () => {
    const text = await run(["context"]);
    expect(text.out).toContain("审核台账 1 项");
    const json = await run(["--json", "context"]);
    const payload = JSON.parse(json.out) as { pendingReview: number };
    expect(payload.pendingReview).toBe(1);
  });

  it("review ack resolves entries; unknown ids fail partially", async () => {
    const bad = await run(["review", "ack", "ZZZZZZ99"]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("error: not in the ledger: ZZZZZZ99");

    const ok = await run(["review", "ack", D4]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain(`acked ${D4}`);
    expect((await run(["review"])).out).toContain("审核台账为空");
  });

  it("forced delete records the removed node's pre-mutation dependents", async () => {
    const { code, out } = await run(["--json", "delete", A1, "--force"]);
    expect(code).toBe(0);
    const results = JSON.parse(out) as Array<{ id: string; pendingReview?: string[] }>;
    expect(results[0]).toMatchObject({ id: A1, pendingReview: [D4] });
    // The graph now has dangling grounds by design; read the ledger directly
    // instead of through graph-gated commands.
    const ledger = await readLedger(repo);
    expect(ledger.pending).toHaveLength(1);
    expect(ledger.pending[0]).toMatchObject({ id: D4, source: A1, kind: "delete" });
  });
});
