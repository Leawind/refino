import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/main.js";
import type { CliIo } from "../src/format.js";
import { constraint, createRefino, premise, removeRefino } from "../../refino/test/helpers.js";

let validRoot: string;
let invalidRoot: string;

beforeAll(async () => {
  validRoot = await createRefino({
    "premises/P-003.md": premise("P-003", "当前 PostgreSQL 版本不支持 extension X。"),
    "constraints/C-001.md": constraint("C-001", undefined, "所有业务数据存储在 PostgreSQL。"),
    "constraints/C-007.md": constraint("C-007", ["C-001"], "数据访问必须通过 Repository 层。"),
    "constraints/C-019.md": constraint(
      "C-019",
      ["P-003", "C-007"],
      "不使用 extension X，改用手写 SQL。",
    ),
  });
  invalidRoot = await createRefino({
    "constraints/C-001.md": constraint("C-001", ["C-002"]),
    "constraints/C-002.md": constraint("C-002", ["C-001"]),
  });
});

afterAll(async () => {
  await removeRefino(validRoot);
  await removeRefino(invalidRoot);
});

function capture(): { io: CliIo; out(): string; err(): string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (text: string) => void out.push(text) },
      stderr: { write: (text: string) => void err.push(text) },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

async function run(argv: string[]) {
  const cap = capture();
  const code = await main(argv, cap.io);
  return { code, out: cap.out(), err: cap.err() };
}

describe("refino cli", () => {
  it("validate succeeds on a valid graph", async () => {
    const { code, out } = await run(["--root", validRoot, "validate"]);
    expect(code).toBe(0);
    expect(out).toContain("valid: 3 constraints, 1 premises");
  });

  it("validate reports cycles with exit code 1", async () => {
    const { code, out } = await run(["--root", invalidRoot, "validate"]);
    expect(code).toBe(1);
    expect(out).toContain("[CYCLE]");
    expect(out).toContain("C-001 -> C-002 -> C-001");
  });

  it("validate emits JSON with --json", async () => {
    const { code, out } = await run(["--root", invalidRoot, "--json", "validate"]);
    expect(code).toBe(1);
    const payload = JSON.parse(out) as { ok: boolean; issues: Array<{ code: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.issues.map((i) => i.code)).toContain("CYCLE");
  });

  it("fails with a clear error when .refino is missing", async () => {
    const emptyRoot = await createRefino({});
    try {
      const { code, err } = await run(["--root", emptyRoot, "list"]);
      expect(code).toBe(1);
      expect(err).toContain("No .refino directory found");
    } finally {
      await removeRefino(emptyRoot);
    }
  });

  it("list prints a table and supports --type", async () => {
    const all = await run(["--root", validRoot, "list"]);
    expect(all.code).toBe(0);
    expect(all.out).toContain("C-019");
    expect(all.out).toContain("P-003");

    const onlyPremises = await run(["--root", validRoot, "list", "--type", "premise"]);
    expect(onlyPremises.code).toBe(0);
    expect(onlyPremises.out).toContain("P-003");
    expect(onlyPremises.out).not.toContain("C-019");
  });

  it("show prints the full record", async () => {
    const { code, out } = await run(["--root", validRoot, "show", "C-019"]);
    expect(code).toBe(0);
    expect(out).toContain("id:      C-019");
    expect(out).toContain("grounds: P-003, C-007");
    expect(out).toContain("不使用 extension X，改用手写 SQL。");
  });

  it("grounds prints resolved grounds in declared order", async () => {
    const { code, out } = await run(["--root", validRoot, "grounds", "C-019"]);
    expect(code).toBe(0);
    expect(out.indexOf("P-003")).toBeLessThan(out.indexOf("C-007"));
  });

  it("ancestors and dependents traverse transitively", async () => {
    const ancestors = await run(["--root", validRoot, "--json", "ancestors", "C-019"]);
    expect(ancestors.code).toBe(0);
    const ancestorList = JSON.parse(ancestors.out) as Array<{ id: string; depth: number }>;
    expect(ancestorList).toEqual([
      expect.objectContaining({ id: "C-007", depth: 1 }),
      expect.objectContaining({ id: "P-003", depth: 1 }),
      expect.objectContaining({ id: "C-001", depth: 2 }),
    ]);

    const dependents = await run(["--root", validRoot, "dependents", "C-001"]);
    expect(dependents.code).toBe(0);
    expect(dependents.out).toContain("C-007");
    expect(dependents.out).toContain("C-019");
  });

  it("impact matches dependents", async () => {
    const impact = await run(["--root", validRoot, "--json", "impact", "C-001"]);
    const dependents = await run(["--root", validRoot, "--json", "dependents", "C-001"]);
    expect(impact.code).toBe(0);
    expect(impact.out).toBe(dependents.out);
  });

  it("queries refuse to run on an invalid graph", async () => {
    const { code, out } = await run(["--root", invalidRoot, "ancestors", "C-001"]);
    expect(code).toBe(1);
    expect(out).toContain("[CYCLE]");
  });

  it("reports unknown node ids on stderr with exit code 1", async () => {
    const { code, err } = await run(["--root", validRoot, "show", "X-999"]);
    expect(code).toBe(1);
    expect(err).toContain('Node "X-999" not found');
  });

  it("returns usage errors with exit code 1", async () => {
    const { code, err } = await run(["--root", validRoot, "frobnicate"]);
    expect(code).toBe(1);
    expect(err).toContain("unknown command");
  });
});
