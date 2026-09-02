import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/main.js";
import type { CliIo } from "../src/format.js";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";

let validRoot: string;
let invalidRoot: string;

beforeAll(async () => {
  validRoot = await createRefino({
    "nodes/1A/2B3C4D.premise.md": premise("1A2B3C4D", "当前 PostgreSQL 版本不支持 extension X。"),
    "nodes/A1/B2C3D4.constraint.md": constraint(
      "A1B2C3D4",
      undefined,
      "所有业务数据存储在 PostgreSQL。",
    ),
    "nodes/D4/E5F6G7.constraint.md": constraint(
      "D4E5F6G7",
      ["A1B2C3D4"],
      "数据访问必须通过 Repository 层。",
    ),
    "nodes/E5/F6G7H8.constraint.md": constraint(
      "E5F6G7H8",
      ["1A2B3C4D", "D4E5F6G7"],
      "不使用 extension X，改用手写 SQL。",
    ),
  });
  invalidRoot = await createRefino({
    "nodes/A1/B2C3D4.constraint.md": constraint("A1B2C3D4", ["B2C3D4E5"]),
    "nodes/B2/C3D4E5.constraint.md": constraint("B2C3D4E5", ["A1B2C3D4"]),
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
    expect(out).toContain("A1B2C3D4 -> B2C3D4E5 -> A1B2C3D4");
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
    expect(all.out).toContain("E5F6G7H8");
    expect(all.out).toContain("1A2B3C4D");

    const onlyPremises = await run(["--root", validRoot, "list", "--type", "premise"]);
    expect(onlyPremises.code).toBe(0);
    expect(onlyPremises.out).toContain("1A2B3C4D");
    expect(onlyPremises.out).not.toContain("E5F6G7H8");
  });

  it("show prints the full record", async () => {
    const { code, out } = await run(["--root", validRoot, "show", "E5F6G7H8"]);
    expect(code).toBe(0);
    expect(out).toContain("constraints(id=E5F6G7H8, grounds=[1A2B3C4D, D4E5F6G7])");
    expect(out).toContain("不使用 extension X，改用手写 SQL。");

    const premiseView = await run(["--root", validRoot, "show", "1A2B3C4D"]);
    expect(premiseView.out).toContain("premises(id=1A2B3C4D)");
  });

  it("grounds prints resolved grounds in declared order", async () => {
    const { code, out } = await run(["--root", validRoot, "grounds", "E5F6G7H8"]);
    expect(code).toBe(0);
    expect(out.indexOf("1A2B3C4D")).toBeLessThan(out.indexOf("D4E5F6G7"));
  });

  it("ancestors and dependents traverse transitively", async () => {
    const ancestors = await run(["--root", validRoot, "--json", "ancestors", "E5F6G7H8"]);
    expect(ancestors.code).toBe(0);
    const [group] = JSON.parse(ancestors.out) as Array<{
      id: string;
      results: Array<{ id: string; depth: number }>;
    }>;
    expect(group.id).toBe("E5F6G7H8");
    expect(group.results).toEqual([
      expect.objectContaining({ id: "1A2B3C4D", depth: 1 }),
      expect.objectContaining({ id: "D4E5F6G7", depth: 1 }),
      expect.objectContaining({ id: "A1B2C3D4", depth: 2 }),
    ]);

    const dependents = await run(["--root", validRoot, "dependents", "A1B2C3D4"]);
    expect(dependents.code).toBe(0);
    expect(dependents.out).toContain("D4E5F6G7");
    expect(dependents.out).toContain("E5F6G7H8");
  });

  it("batch queries group results under each queried id", async () => {
    const { code, out } = await run([
      "--root",
      validRoot,
      "--json",
      "dependents",
      "A1B2C3D4",
      "D4E5F6G7",
    ]);
    expect(code).toBe(0);
    const groups = JSON.parse(out) as Array<{
      id: string;
      results: Array<{ id: string; depth: number }>;
    }>;
    expect(groups.map((g) => g.id)).toEqual(["A1B2C3D4", "D4E5F6G7"]);
    expect(groups[0]!.results.map((r) => [r.id, r.depth])).toEqual([
      ["D4E5F6G7", 1],
      ["E5F6G7H8", 2],
    ]);
    expect(groups[1]!.results.map((r) => [r.id, r.depth])).toEqual([["E5F6G7H8", 1]]);
  });

  it("batch human-readable output prints one section per queried id", async () => {
    const { code, out } = await run(["--root", validRoot, "dependents", "A1B2C3D4", "E5F6G7H8"]);
    expect(code).toBe(0);
    expect(out).toContain("A1B2C3D4:");
    expect(out).toContain("E5F6G7H8:\n(empty)\n");
    expect(out.indexOf("D4E5F6G7")).toBeLessThan(out.indexOf("E5F6G7H8:"));
  });

  it("show prints several full records when given multiple ids", async () => {
    const { code, out } = await run([
      "--root",
      validRoot,
      "--json",
      "show",
      "E5F6G7H8",
      "1A2B3C4D",
    ]);
    expect(code).toBe(0);
    const nodes = JSON.parse(out) as Array<{ id: string; body?: string }>;
    expect(nodes.map((n) => n.id)).toEqual(["E5F6G7H8", "1A2B3C4D"]);
    expect(nodes.every((n) => typeof n.body === "string")).toBe(true);
  });

  it("queries refuse to run on an invalid graph", async () => {
    const { code, out } = await run(["--root", invalidRoot, "ancestors", "A1B2C3D4"]);
    expect(code).toBe(1);
    expect(out).toContain("[CYCLE]");
  });

  it("reports unknown node ids inline and exits with code 1", async () => {
    const { code, out, err } = await run(["--root", validRoot, "show", "9M8N7P6Q"]);
    expect(code).toBe(1);
    expect(err).toBe("");
    expect(out).toContain('error: Node "9M8N7P6Q" not found');

    const asJson = await run(["--root", validRoot, "--json", "show", "9M8N7P6Q"]);
    expect(asJson.code).toBe(1);
    expect(JSON.parse(asJson.out)).toEqual([
      { id: "9M8N7P6Q", error: 'Node "9M8N7P6Q" not found' },
    ]);
  });

  it("batch queries still return results for the ids that exist", async () => {
    const { code, out } = await run([
      "--root",
      validRoot,
      "--json",
      "dependents",
      "A1B2C3D4",
      "9M8N7P6Q",
    ]);
    expect(code).toBe(1);
    const groups = JSON.parse(out) as Array<{
      id: string;
      results?: Array<{ id: string }>;
      error?: string;
    }>;
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({
      id: "A1B2C3D4",
      results: [
        expect.objectContaining({ id: "D4E5F6G7" }),
        expect.objectContaining({ id: "E5F6G7H8" }),
      ],
    });
    expect(groups[1]).toEqual({ id: "9M8N7P6Q", error: 'Node "9M8N7P6Q" not found' });

    const human = await run(["--root", validRoot, "dependents", "A1B2C3D4", "9M8N7P6Q"]);
    expect(human.code).toBe(1);
    expect(human.out).toContain("A1B2C3D4:");
    expect(human.out).toContain('error: Node "9M8N7P6Q" not found');
  });

  it("returns usage errors with exit code 1", async () => {
    const { code, err } = await run(["--root", validRoot, "frobnicate"]);
    expect(code).toBe(1);
    expect(err).toContain("unknown command");
  });

  it("new premise creates a premise node and prints id and path", async () => {
    const emptyRoot = await createRefino({});
    try {
      const { code, out } = await run([
        "--root",
        emptyRoot,
        "new",
        "premise",
        "--body",
        "PostgreSQL 16 is in use.",
        "--confirmed",
        "2026-05-01T00:00:00Z",
      ]);
      expect(code).toBe(0);
      const match = /created ([0-9A-HJKMNP-TV-Z]{8}) \(/.exec(out);
      expect(match).not.toBeNull();
      const id = match![1]!;
      expect(out).toContain(`.refino/nodes/${id.slice(0, 2)}/${id.slice(2)}.premise.md`);

      const list = await run(["--root", emptyRoot, "--json", "list", "--type", "premise"]);
      const nodes = JSON.parse(list.out) as Array<{ id: string }>;
      expect(nodes.map((n) => n.id)).toEqual([id]);
    } finally {
      await removeRefino(emptyRoot);
    }
  });

  it("new constraint creates a constraint node with grounds and rationale", async () => {
    const emptyRoot = await createRefino({});
    try {
      await run(["--root", emptyRoot, "new", "premise", "--body", "Fact."]);
      const { code, out } = await run([
        "--root",
        emptyRoot,
        "new",
        "constraint",
        "--body",
        "Use Repository layer.",
        "--grounds",
        "1A2B3C4D",
        "--rationale",
        "Keeps DB access testable.",
      ]);
      expect(code).toBe(0);
      expect(out).toContain(".refino/nodes/");

      const validate = await run(["--root", emptyRoot, "--json", "validate"]);
      // the grounds reference 1A2B3C4D does not exist -> reported as an issue
      expect(validate.code).toBe(1);
    } finally {
      await removeRefino(emptyRoot);
    }
  });

  it("new premise --now stamps the current UTC time and validates", async () => {
    const emptyRoot = await createRefino({});
    try {
      const { code } = await run([
        "--root",
        emptyRoot,
        "new",
        "premise",
        "--body",
        "Fact.",
        "--now",
      ]);
      expect(code).toBe(0);

      const validate = await run(["--root", emptyRoot, "--json", "validate"]);
      expect(validate.code).toBe(0);
      const payload = JSON.parse(validate.out) as { ok: boolean };
      expect(payload.ok).toBe(true);

      const list = await run(["--root", emptyRoot, "--json", "list", "--type", "premise"]);
      const nodes = JSON.parse(list.out) as Array<{ id: string }>;
      const show = await run(["--root", emptyRoot, "--json", "show", nodes[0]!.id]);
      const [node] = JSON.parse(show.out) as Array<{ confirmed?: string }>;
      expect(node!.confirmed).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    } finally {
      await removeRefino(emptyRoot);
    }
  });

  it("new premise rejects --now together with --confirmed", async () => {
    const emptyRoot = await createRefino({});
    try {
      const { code, err } = await run([
        "--root",
        emptyRoot,
        "new",
        "premise",
        "--body",
        "Fact.",
        "--now",
        "--confirmed",
        "2026-05-01T00:00:00Z",
      ]);
      expect(code).toBe(1);
      expect(err).toContain("mutually exclusive");
    } finally {
      await removeRefino(emptyRoot);
    }
  });

  it("new emits JSON with --json", async () => {
    const emptyRoot = await createRefino({});
    try {
      const { code, out } = await run([
        "--root",
        emptyRoot,
        "--json",
        "new",
        "constraint",
        "--body",
        "Root decision.",
      ]);
      expect(code).toBe(0);
      const payload = JSON.parse(out) as { id: string; file: string };
      expect(payload.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
      expect(payload.file).toBe(
        `nodes/${payload.id.slice(0, 2)}/${payload.id.slice(2)}.constraint.md`,
      );
    } finally {
      await removeRefino(emptyRoot);
    }
  });

  it("new constraint rejects malformed --grounds ids before creating", async () => {
    const root = await createRefino({ "nodes/1A/2B3C4D.premise.md": premise("1A2B3C4D") });
    try {
      const { code, err } = await run([
        "--root",
        root,
        "new",
        "constraint",
        "--body",
        "Decision.",
        "--grounds",
        "ILOU2345",
      ]);
      expect(code).toBe(1);
      expect(err).toContain('invalid ground id "ILOU2345"');

      const list = await run(["--root", root, "--json", "list"]);
      const nodes = JSON.parse(list.out) as Array<{ id: string }>;
      expect(nodes.map((n) => n.id)).toEqual(["1A2B3C4D"]);
    } finally {
      await removeRefino(root);
    }
  });

  it("human-readable ancestors/dependents output includes the depth column", async () => {
    const ancestors = await run(["--root", validRoot, "ancestors", "E5F6G7H8"]);
    expect(ancestors.code).toBe(0);
    const lines = ancestors.out.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^1A2B3C4D\s+premise\s+1\s+/);
    expect(lines[1]).toMatch(/^D4E5F6G7\s+constraint\s+1\s+/);
    expect(lines[2]).toMatch(/^A1B2C3D4\s+constraint\s+2\s+/);

    const list = await run(["--root", validRoot, "list"]);
    expect(list.out).toMatch(/1A2B3C4D\s+premise\s+/); // no depth column without depths
  });

  it("deps alias and impact command are removed", async () => {
    const deps = await run(["--root", validRoot, "deps", "A1B2C3D4"]);
    expect(deps.code).toBe(1);
    expect(deps.err).toContain("unknown command");

    const impact = await run(["--root", validRoot, "impact", "A1B2C3D4"]);
    expect(impact.code).toBe(1);
    expect(impact.err).toContain("unknown command");
  });

  it("new premise --id creates the node under the given id", async () => {
    const emptyRoot = await createRefino({});
    try {
      const { code, out } = await run([
        "--root",
        emptyRoot,
        "new",
        "premise",
        "--id",
        "A1B2C3D4",
        "--body",
        "Fact.",
      ]);
      expect(code).toBe(0);
      expect(out).toContain("created A1B2C3D4 (.refino/nodes/A1/B2C3D4.premise.md)");
    } finally {
      await removeRefino(emptyRoot);
    }
  });

  it("new rejects an invalid --id with exit code 1", async () => {
    const emptyRoot = await createRefino({});
    try {
      const { code, err } = await run([
        "--root",
        emptyRoot,
        "new",
        "constraint",
        "--id",
        "ILOU2345",
        "--body",
        "Decision.",
      ]);
      expect(code).toBe(1);
      expect(err).toContain("Node id must be an 8-character Crockford base32 id");
    } finally {
      await removeRefino(emptyRoot);
    }
  });
});
