import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../src/main.js";
import type { CliIo } from "../src/format.js";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";

let validRoot: string;
let invalidRoot: string;

beforeAll(async () => {
  validRoot = await createRefino({
    "nodes/1A/2B3C4D-premise.md": premise("1A2B3C4D", "当前 PostgreSQL 版本不支持 extension X。"),
    "nodes/A1/B2C3D4-constraint.md": constraint(
      "A1B2C3D4",
      undefined,
      "所有业务数据存储在 PostgreSQL。",
    ),
    "nodes/D4/E5F6G7-constraint.md": constraint(
      "D4E5F6G7",
      ["A1B2C3D4"],
      "数据访问必须通过 Repository 层。",
    ),
    "nodes/E5/F6G7H8-constraint.md": constraint(
      "E5F6G7H8",
      ["1A2B3C4D", "D4E5F6G7"],
      "不使用 extension X，改用手写 SQL。",
    ),
  });
  invalidRoot = await createRefino({
    "nodes/A1/B2C3D4-constraint.md": constraint("A1B2C3D4", ["B2C3D4E5"]),
    "nodes/B2/C3D4E5-constraint.md": constraint("B2C3D4E5", ["A1B2C3D4"]),
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

  it("list orders nodes upstream before downstream (layer, then id)", async () => {
    // Id order alone would put the downstream node first; the layer must win.
    const root = await createRefino({
      "nodes/AA/A1111BB-constraint.md": constraint("AAA1111BB", ["ZZZ9999YX"], "下游约束。"),
      "nodes/ZZ/Z9999YX-constraint.md": constraint("ZZZ9999YX", undefined, "上游约束。"),
    });
    try {
      const { code, out } = await run(["--root", root, "list"]);
      expect(code).toBe(0);
      const rows = out
        .split("\n")
        .filter((line) => line.includes("AAA1111BB") || line.includes("ZZZ9999YX"));
      expect(rows).toHaveLength(2);
      expect(rows[0]).toContain("ZZZ9999YX");
      expect(rows[1]).toContain("AAA1111BB");
    } finally {
      await removeRefino(root);
    }
  });

  it("show prints the full record", async () => {
    const { code, out } = await run(["--root", validRoot, "show", "E5F6G7H8"]);
    expect(code).toBe(0);
    expect(out).toContain("constraints(id=E5F6G7H8, grounds=[1A2B3C4D, D4E5F6G7])");
    expect(out).toContain("不使用 extension X，改用手写 SQL。");

    const premiseView = await run(["--root", validRoot, "show", "1A2B3C4D"]);
    expect(premiseView.out).toContain("premises(id=1A2B3C4D)");
  });

  it("show text output labels summary, rationale and confirmed", async () => {
    const emptyRoot = await createRefino({});
    try {
      await run([
        "--root",
        emptyRoot,
        "new",
        "premise",
        "--id",
        "1A2B3C4D",
        "--body",
        "Fact.",
        "--summary",
        "A premise summary.",
        "--confirmed",
        "2026-05-01T00:00:00Z",
      ]);
      await run([
        "--root",
        emptyRoot,
        "new",
        "constraint",
        "--id",
        "D4E5F6G7",
        "--body",
        "Decision.",
        "--grounds",
        "1A2B3C4D",
        "--rationale",
        "Because of the fact.",
        "--summary",
        "A constraint summary.",
      ]);

      const constraintView = await run(["--root", emptyRoot, "show", "D4E5F6G7"]);
      expect(constraintView.out).toContain("summary: A constraint summary.");
      expect(constraintView.out).toContain("rationale: Because of the fact.");
      expect(constraintView.out).not.toContain("confirmed:");

      const premiseView = await run(["--root", emptyRoot, "show", "1A2B3C4D"]);
      expect(premiseView.out).toContain("summary: A premise summary.");
      expect(premiseView.out).toContain("confirmed: 2026-05-01T00:00:00Z");
      expect(premiseView.out).not.toContain("rationale:");
    } finally {
      await removeRefino(emptyRoot);
    }
  });

  it("list --unreferenced lists only premises no constraint grounds on", async () => {
    const root = await createRefino({
      "nodes/1A/2B3C4D-premise.md": premise("1A2B3C4D", "Unreferenced fact."),
      "nodes/2B/3C4D5E-premise.md": premise("2B3C4D5E", "Referenced fact."),
      "nodes/C1/234567-constraint.md": constraint("C1234567", ["2B3C4D5E"], "Decision."),
    });
    try {
      const all = await run(["--root", root, "list", "--unreferenced"]);
      expect(all.code).toBe(0);
      expect(all.out).toContain("1A2B3C4D");
      expect(all.out).not.toContain("2B3C4D5E");
      expect(all.out).not.toContain("C1234567");

      const withType = await run(["--root", root, "list", "--type", "premise", "--unreferenced"]);
      expect(withType.code).toBe(0);
      expect(withType.out).toContain("1A2B3C4D");

      const constraintType = await run([
        "--root",
        root,
        "list",
        "--type",
        "constraint",
        "--unreferenced",
      ]);
      expect(constraintType.code).toBe(1);
      expect(constraintType.err).toContain("--unreferenced only applies to premises");

      const json = await run(["--root", root, "--json", "list", "--unreferenced"]);
      const nodes = JSON.parse(json.out) as Array<{ id: string }>;
      expect(nodes.map((n) => n.id)).toEqual(["1A2B3C4D"]);
    } finally {
      await removeRefino(root);
    }
  });

  describe("update", () => {
    it("changes only the given fields and replaces grounds wholesale", async () => {
      const emptyRoot = await createRefino({});
      try {
        await run(["--root", emptyRoot, "new", "premise", "--id", "1A2B3C4D", "--body", "Fact."]);
        await run([
          "--root",
          emptyRoot,
          "new",
          "premise",
          "--id",
          "2B3C4D5E",
          "--body",
          "Other fact.",
        ]);
        await run([
          "--root",
          emptyRoot,
          "new",
          "constraint",
          "--id",
          "D4E5F6G7",
          "--body",
          "Decision.",
          "--grounds",
          "1A2B3C4D",
          "--rationale",
          "Because.",
          "--summary",
          "A summary.",
        ]);

        const { code, out } = await run([
          "--root",
          emptyRoot,
          "update",
          "D4E5F6G7",
          "--body",
          "New decision.",
          "--grounds",
          "2B3C4D5E",
        ]);
        expect(code).toBe(0);
        expect(out).toContain("updated D4E5F6G7");

        const show = await run(["--root", emptyRoot, "--json", "show", "D4E5F6G7"]);
        const [group] = JSON.parse(show.out) as Array<{
          results: Array<{ body: string; grounds: string[]; rationale?: string; summary: string }>;
        }>;
        const node = group!.results[0]!;
        expect(node.body).toBe("New decision.");
        expect(node.grounds).toEqual(["2B3C4D5E"]);
        expect(node.rationale).toBe("Because.");
        expect(node.summary).toBe("A summary.");

        // premise field update via --now
        const now = await run(["--root", emptyRoot, "update", "1A2B3C4D", "--now"]);
        expect(now.code).toBe(0);
        const premiseShow = await run(["--root", emptyRoot, "--json", "show", "1A2B3C4D"]);
        const [premiseGroup] = JSON.parse(premiseShow.out) as Array<{
          results: Array<{ confirmed?: string }>;
        }>;
        expect(premiseGroup!.results[0]!.confirmed).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
        );
      } finally {
        await removeRefino(emptyRoot);
      }
    });

    it("keeps a body-derived summary derived instead of materializing it", async () => {
      const emptyRoot = await createRefino({});
      try {
        await run(["--root", emptyRoot, "new", "premise", "--id", "1A2B3C4D", "--body", "Fact."]);
        const { code } = await run([
          "--root",
          emptyRoot,
          "update",
          "1A2B3C4D",
          "--body",
          "Changed fact.",
        ]);
        expect(code).toBe(0);

        const source = await readFile(
          join(emptyRoot, ".refino", "nodes", "1A", "2B3C4D-premise.md"),
          "utf8",
        );
        expect(source).not.toContain("summary:");
      } finally {
        await removeRefino(emptyRoot);
      }
    });

    it("rejects missing nodes, type mismatches, empty edits and invalid values", async () => {
      const emptyRoot = await createRefino({});
      try {
        await run(["--root", emptyRoot, "new", "premise", "--id", "1A2B3C4D", "--body", "Fact."]);

        const missing = await run(["--root", emptyRoot, "update", "D4E5F6G7", "--body", "x"]);
        expect(missing.code).toBe(1);
        expect(missing.err).toContain("not found");

        const noFields = await run(["--root", emptyRoot, "update", "1A2B3C4D"]);
        expect(noFields.code).toBe(1);
        expect(noFields.err).toContain("at least one field");

        const premiseRationale = await run([
          "--root",
          emptyRoot,
          "update",
          "1A2B3C4D",
          "--rationale",
          "x",
        ]);
        expect(premiseRationale.code).toBe(1);
        expect(premiseRationale.err).toContain("do not support");

        const badConfirmed = await run([
          "--root",
          emptyRoot,
          "update",
          "1A2B3C4D",
          "--confirmed",
          "2026-05-01",
        ]);
        expect(badConfirmed.code).toBe(1);
        expect(badConfirmed.err).toContain("RFC 3339");

        await run([
          "--root",
          emptyRoot,
          "new",
          "constraint",
          "--id",
          "D4E5F6G7",
          "--body",
          "Decision.",
        ]);
        const constraintConfirmed = await run(["--root", emptyRoot, "update", "D4E5F6G7", "--now"]);
        expect(constraintConfirmed.code).toBe(1);
        expect(constraintConfirmed.err).toContain("do not support");

        const unknownGround = await run([
          "--root",
          emptyRoot,
          "update",
          "D4E5F6G7",
          "--grounds",
          "1A2B3C4D,2B3C4D5E",
        ]);
        expect(unknownGround.code).toBe(1);
        expect(unknownGround.err).toContain("[UNKNOWN_GROUND]");
      } finally {
        await removeRefino(emptyRoot);
      }
    });
  });

  describe("delete", () => {
    it("refuses while others ground on the target and deletes leaves", async () => {
      const emptyRoot = await createRefino({});
      try {
        await run(["--root", emptyRoot, "new", "premise", "--id", "1A2B3C4D", "--body", "Fact."]);
        await run([
          "--root",
          emptyRoot,
          "new",
          "constraint",
          "--id",
          "D4E5F6G7",
          "--body",
          "Middle decision.",
          "--grounds",
          "1A2B3C4D",
        ]);
        await run([
          "--root",
          emptyRoot,
          "new",
          "constraint",
          "--id",
          "E5F6G7H8",
          "--body",
          "Leaf decision.",
          "--grounds",
          "D4E5F6G7",
        ]);

        const blocked = await run(["--root", emptyRoot, "delete", "D4E5F6G7"]);
        expect(blocked.code).toBe(1);
        expect(blocked.out).toContain("grounded on by E5F6G7H8");
        expect(blocked.out).toContain("--force");
        const stillThere = await run(["--root", emptyRoot, "--json", "show", "D4E5F6G7"]);
        expect(stillThere.code).toBe(0);

        const leaf = await run(["--root", emptyRoot, "delete", "E5F6G7H8"]);
        expect(leaf.code).toBe(0);
        expect(leaf.out).toContain("deleted E5F6G7H8");
        const gone = await run(["--root", emptyRoot, "show", "E5F6G7H8"]);
        expect(gone.code).toBe(1);
      } finally {
        await removeRefino(emptyRoot);
      }
    });

    it("supports partial success over a batch", async () => {
      const emptyRoot = await createRefino({});
      try {
        await run(["--root", emptyRoot, "new", "premise", "--id", "1A2B3C4D", "--body", "Fact."]);
        const { code, out } = await run(["--root", emptyRoot, "delete", "1A2B3C4D", "D4E5F6G7"]);
        expect(code).toBe(1);
        expect(out).toContain("deleted 1A2B3C4D");
        expect(out).toContain('error: node "D4E5F6G7" not found');

        const json = await run(["--root", emptyRoot, "--json", "delete", "D4E5F6G7"]);
        const results = JSON.parse(json.out) as Array<{ id: string; error?: string }>;
        expect(results).toEqual([{ id: "D4E5F6G7", error: 'node "D4E5F6G7" not found' }]);
      } finally {
        await removeRefino(emptyRoot);
      }
    });

    it("--force deletes through dependents and warns", async () => {
      const emptyRoot = await createRefino({});
      try {
        await run(["--root", emptyRoot, "new", "premise", "--id", "1A2B3C4D", "--body", "Fact."]);
        await run([
          "--root",
          emptyRoot,
          "new",
          "constraint",
          "--id",
          "D4E5F6G7",
          "--body",
          "Decision.",
          "--grounds",
          "1A2B3C4D",
        ]);

        const { code, out, err } = await run([
          "--root",
          emptyRoot,
          "delete",
          "1A2B3C4D",
          "--force",
        ]);
        expect(code).toBe(0);
        expect(out).toContain("deleted 1A2B3C4D");
        expect(err).toContain("grounded on by D4E5F6G7");

        // the dangling reference surfaces as a validation issue
        const validate = await run(["--root", emptyRoot, "validate"]);
        expect(validate.code).toBe(1);
        expect(validate.out).toContain("[UNKNOWN_GROUND]");
      } finally {
        await removeRefino(emptyRoot);
      }
    });
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
    const groups = JSON.parse(out) as Array<{ id: string; results: Array<{ body?: string }> }>;
    expect(groups.map((g) => g.id)).toEqual(["E5F6G7H8", "1A2B3C4D"]);
    expect(groups.every((g) => typeof g.results[0]?.body === "string")).toBe(true);
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
      expect(out).toContain(`.refino/nodes/${id.slice(0, 2)}/${id.slice(2)}-premise.md`);

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
      await run(["--root", emptyRoot, "new", "premise", "--id", "1A2B3C4D", "--body", "Fact."]);
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
      expect(validate.code).toBe(0);
      expect((JSON.parse(validate.out) as { ok: boolean }).ok).toBe(true);
    } finally {
      await removeRefino(emptyRoot);
    }
  });

  it("new constraint rejects unknown grounds before creating anything", async () => {
    const emptyRoot = await createRefino({});
    try {
      await run(["--root", emptyRoot, "new", "premise", "--id", "1A2B3C4D", "--body", "Fact."]);
      const { code, err } = await run([
        "--root",
        emptyRoot,
        "new",
        "constraint",
        "--body",
        "Decision.",
        "--grounds",
        "1A2B3C4D,2B3C4D5E",
      ]);
      expect(code).toBe(1);
      expect(err).toContain("[UNKNOWN_GROUND]");
      expect(err).toContain("2B3C4D5E");

      const validate = await run(["--root", emptyRoot, "--json", "validate"]);
      expect(validate.code).toBe(0); // nothing was written
    } finally {
      await removeRefino(emptyRoot);
    }
  });

  it("new constraint rejects repeated ground ids", async () => {
    const emptyRoot = await createRefino({});
    try {
      await run(["--root", emptyRoot, "new", "premise", "--id", "1A2B3C4D", "--body", "Fact."]);
      const { code, err } = await run([
        "--root",
        emptyRoot,
        "new",
        "constraint",
        "--body",
        "Decision.",
        "--grounds",
        "1A2B3C4D,1A2B3C4D",
      ]);
      expect(code).toBe(1);
      expect(err).toContain("[INVALID_GROUNDS]");
    } finally {
      await removeRefino(emptyRoot);
    }
  });

  it("new constraint still works when .refino does not exist yet", async () => {
    const emptyRoot = await createRefino({});
    await removeRefino(emptyRoot); // drop the .refino directory itself
    try {
      const { code } = await run([
        "--root",
        emptyRoot,
        "new",
        "constraint",
        "--body",
        "Root decision.",
      ]);
      expect(code).toBe(0);
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
      const [group] = JSON.parse(show.out) as Array<{ results: Array<{ confirmed?: string }> }>;
      expect(group!.results[0]!.confirmed).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
      );
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
        `nodes/${payload.id.slice(0, 2)}/${payload.id.slice(2)}-constraint.md`,
      );
    } finally {
      await removeRefino(emptyRoot);
    }
  });

  it("new constraint rejects malformed --grounds ids before creating", async () => {
    const root = await createRefino({ "nodes/1A/2B3C4D-premise.md": premise("1A2B3C4D") });
    try {
      const { code, err } = await run([
        "--root",
        root,
        "new",
        "constraint",
        "--body",
        "Decision.",
        "--grounds",
        "ilou2345",
      ]);
      expect(code).toBe(1);
      expect(err).toContain('invalid ground id "ilou2345"');

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
      expect(out).toContain("created A1B2C3D4 (.refino/nodes/A1/B2C3D4-premise.md)");
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
        "a1b2c3d4",
        "--body",
        "Decision.",
      ]);
      expect(code).toBe(1);
      expect(err).toContain("Node id must be 3-16 characters of A-Z, 0-9 or _");
    } finally {
      await removeRefino(emptyRoot);
    }
  });

  it("new --summary stores an explicit summary in frontmatter", async () => {
    const emptyRoot = await createRefino({});
    try {
      const { code } = await run([
        "--root",
        emptyRoot,
        "new",
        "constraint",
        "--body",
        "Very long decision body.",
        "--summary",
        "Short summary.",
      ]);
      expect(code).toBe(0);
      const list = await run(["--root", emptyRoot, "--json", "list"]);
      const [node] = JSON.parse(list.out) as Array<{ id: string; summary: string }>;
      expect(node.summary).toBe("Short summary.");
    } finally {
      await removeRefino(emptyRoot);
    }
  });
});
