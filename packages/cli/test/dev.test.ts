import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/main.js";
import type { CliIo } from "../src/format.js";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";

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

interface ListedNode {
  id: string;
  type: "premise" | "constraint";
  grounds?: string[];
}

/** Longest constraint-chain in the listed graph (premises do not extend chains). */
function maxChainDepth(nodes: ListedNode[]): number {
  const constraints = nodes.filter((n) => n.type === "constraint");
  const depths = new Map<string, number>();
  const depth = (id: string): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    depths.set(id, 0); // cycle guard; the graph is a DAG
    const node = constraints.find((n) => n.id === id);
    // Grounds may reference premises, which never extend a chain.
    const value = node === undefined ? 0 : 1 + Math.max(-1, ...node.grounds!.map(depth));
    depths.set(id, value);
    return value;
  };
  return Math.max(0, ...constraints.map((n) => depth(n.id)));
}

async function listJson(root: string): Promise<ListedNode[]> {
  const list = await run(["--root", root, "--json", "list"]);
  expect(list.code).toBe(0);
  return JSON.parse(list.out) as ListedNode[];
}

/** All files under `<root>/.refino` as a relative-path -> content map. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), relative);
      } else {
        files.set(relative, await readFile(join(dir, entry.name), "utf8"));
      }
    }
  };
  await walk(join(root, ".refino"), "");
  return files;
}

/** Count premise files whose frontmatter carries a `confirmed` timestamp. */
async function countConfirmedPremises(root: string, nodes: ListedNode[]): Promise<number> {
  const premiseFiles = nodes
    .filter((n) => n.type === "premise")
    .map((n) => join(root, ".refino", "nodes", n.id.slice(0, 2), `${n.id.slice(2)}-premise.md`));
  const contents = await Promise.all(premiseFiles.map((file) => readFile(file, "utf8")));
  return contents.filter((content) => content.includes("confirmed:")).length;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("refino dev (hidden command)", () => {
  it("behaves exactly like an unknown command without REFINO_DEV", async () => {
    vi.stubEnv("REFINO_DEV", "");
    const dev = await run(["dev", "generate", "--nodes", "5"]);
    const unknown = await run(["not-a-command"]);
    expect(dev.code).toBe(unknown.code);
    // The error text differs only in the offending command name; normalize it
    // to compare the rest of the output byte for byte.
    expect(dev.err.replace("'dev'", "'X'")).toBe(unknown.err.replace("'not-a-command'", "'X'"));
    expect(dev.out).toBe(unknown.out);

    const help = await run(["--help"]);
    expect(help.out).not.toMatch(/^\s+dev\b/m);
  });

  it("generates a valid graph with the requested counts and ratio", async () => {
    vi.stubEnv("REFINO_DEV", "true");
    const root = await createRefino({});
    try {
      const { code, out } = await run([
        "--root",
        root,
        "dev",
        "generate",
        "--nodes",
        "50",
        "--premise-ratio",
        "0.2",
        "--seed",
        "42",
      ]);
      expect(code).toBe(0);
      expect(out).toContain("10 premises");
      expect(out).toContain("40 constraints");
      expect(out).toContain("(seed 42)");

      const validate = await run(["--root", root, "validate", "--json"]);
      expect(validate.code).toBe(0);
      expect(JSON.parse(validate.out)).toMatchObject({ ok: true });

      const nodes = await listJson(root);
      expect(nodes).toHaveLength(50);
      const premises = nodes.filter((n) => n.type === "premise");
      const constraints = nodes.filter((n) => n.type === "constraint");
      expect(premises).toHaveLength(10);
      expect(constraints).toHaveLength(40);
      // Root constraints exist and everything else has at least one ground.
      const roots = constraints.filter((n) => (n.grounds?.length ?? 0) === 0);
      expect(roots.length).toBeGreaterThanOrEqual(1);
      expect(constraints.filter((n) => (n.grounds?.length ?? 0) > 0).length).toBe(
        40 - roots.length,
      );
      // Default confirmed-ratio 1: every premise carries a timestamp.
      expect(await countConfirmedPremises(root, nodes)).toBe(10);
    } finally {
      await removeRefino(root);
    }
  });

  it("is deterministic for the same seed and options", async () => {
    vi.stubEnv("REFINO_DEV", "true");
    const first = await createRefino({});
    const second = await createRefino({});
    try {
      for (const root of [first, second]) {
        const { code } = await run([
          "--root",
          root,
          "dev",
          "generate",
          "--nodes",
          "30",
          "--seed",
          "7",
        ]);
        expect(code).toBe(0);
      }
      expect([...(await snapshot(first)).entries()]).toEqual([
        ...(await snapshot(second)).entries(),
      ]);
    } finally {
      await removeRefino(first);
      await removeRefino(second);
    }
  });

  it("honors --roots, --max-grounds and --max-depth", async () => {
    vi.stubEnv("REFINO_DEV", "true");
    const root = await createRefino({});
    try {
      const { code, out } = await run([
        "--root",
        root,
        "dev",
        "generate",
        "--json",
        "--nodes",
        "40",
        "--premise-ratio",
        "0.25",
        "--roots",
        "3",
        "--max-grounds",
        "1",
        "--max-depth",
        "2",
        "--seed",
        "1",
      ]);
      expect(code).toBe(0);
      const payload = JSON.parse(out) as {
        premises: number;
        constraints: number;
        roots: number;
        seed: number;
      };
      expect(payload.premises).toBe(10);
      expect(payload.constraints).toBe(30);
      expect(payload.roots).toBe(3);
      expect(payload.seed).toBe(1);

      const nodes = await listJson(root);
      expect(maxChainDepth(nodes)).toBeLessThanOrEqual(2);
      const constraintGrounds = nodes
        .filter((n) => n.type === "constraint")
        .map((n) => n.grounds?.length ?? 0);
      expect(constraintGrounds.filter((count) => count > 0).every((count) => count === 1)).toBe(
        true,
      );
    } finally {
      await removeRefino(root);
    }
  });

  it("respects --confirmed-ratio and --roots 0 with premises present", async () => {
    vi.stubEnv("REFINO_DEV", "true");
    const root = await createRefino({});
    try {
      const { code } = await run([
        "--root",
        root,
        "dev",
        "generate",
        "--nodes",
        "20",
        "--premise-ratio",
        "0.5",
        "--roots",
        "0",
        "--confirmed-ratio",
        "0.4",
        "--seed",
        "3",
      ]);
      expect(code).toBe(0);

      const nodes = await listJson(root);
      // With no root constraints, every constraint still grounds on at least
      // one node (premises and/or earlier constraints).
      expect(
        nodes.filter((n) => n.type === "constraint").every((n) => (n.grounds?.length ?? 0) > 0),
      ).toBe(true);
      expect(await countConfirmedPremises(root, nodes)).toBe(4);
    } finally {
      await removeRefino(root);
    }
  });

  it("builds a single deep chain when grounds are constrained to one", async () => {
    vi.stubEnv("REFINO_DEV", "true");
    const root = await createRefino({});
    try {
      const { code } = await run([
        "--root",
        root,
        "dev",
        "generate",
        "--nodes",
        "12",
        "--premise-ratio",
        "0",
        "--roots",
        "1",
        "--max-grounds",
        "1",
        "--seed",
        "5",
      ]);
      expect(code).toBe(0);
      const nodes = await listJson(root);
      const constraints = nodes.filter((n) => n.type === "constraint");
      expect(constraints).toHaveLength(12);
      expect(maxChainDepth(nodes)).toBe(11);
      expect(
        constraints.filter((n) => n.grounds !== undefined && n.grounds.length > 1),
      ).toHaveLength(0);
    } finally {
      await removeRefino(root);
    }
  });

  it("refuses a non-empty .refino without --force and adds nodes with it", async () => {
    vi.stubEnv("REFINO_DEV", "true");
    const root = await createRefino({
      "nodes/A1/B2C3D4-premise.md": premise("A1B2C3D4", "既有前提。"),
    });
    try {
      const refused = await run(["--root", root, "dev", "generate", "--nodes", "5"]);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain("not empty");

      const forced = await run(["--root", root, "dev", "generate", "--nodes", "5", "--force"]);
      expect(forced.code).toBe(0);
      expect(await listJson(root)).toHaveLength(6);
    } finally {
      await removeRefino(root);
    }
  });

  it("rejects out-of-range option values without writing anything", async () => {
    vi.stubEnv("REFINO_DEV", "true");
    const root = await createRefino({});
    // An existing (empty) .refino so the final `list` can read it.
    await mkdir(join(root, ".refino"), { recursive: true });
    try {
      for (const argv of [
        ["--root", root, "dev", "generate", "--nodes", "0"],
        ["--root", root, "dev", "generate", "--nodes", "10", "--premise-ratio", "1.5"],
        [
          "--root",
          root,
          "dev",
          "generate",
          "--nodes",
          "10",
          "--premise-ratio",
          "0",
          "--roots",
          "12",
        ],
        ["--root", root, "dev", "generate", "--nodes", "10", "--max-depth", "0"],
        ["--root", root, "dev", "generate", "--nodes", "10", "--seed", "-1"],
      ]) {
        const { code, err } = await run(argv);
        expect(code).toBe(1);
        expect(err).toContain("error:");
      }
      expect(await listJson(root)).toHaveLength(0);
    } finally {
      await removeRefino(root);
    }
  });

  it("keeps the generated data consumable by other subcommands", async () => {
    vi.stubEnv("REFINO_DEV", "true");
    const root = await createRefino({});
    try {
      await run(["--root", root, "dev", "generate", "--nodes", "8", "--seed", "9"]);
      const nodes = await listJson(root);
      const grounded = nodes.filter((n) => n.type === "constraint" && (n.grounds?.length ?? 0) > 0);
      const target = grounded[grounded.length - 1] ?? nodes[0]!;
      const ancestors = await run(["--root", root, "ancestors", target.id]);
      expect(ancestors.code).toBe(0);
      const dependents = await run(["--root", root, "--json", "dependents", target.id]);
      expect(dependents.code).toBe(0);
      expect(() => JSON.parse(dependents.out)).not.toThrow();
      const show = await run(["--root", root, "show", target.id]);
      expect(show.code).toBe(0);
      expect(show.out).toContain(target.id);
    } finally {
      await removeRefino(root);
    }
  });

  it("coexists with hand-written fixture files under --force", async () => {
    vi.stubEnv("REFINO_DEV", "true");
    const root = await createRefino({
      "nodes/DE/ADBEEF-constraint.md": constraint("DEADBEEF", undefined, "手写根约束。"),
    });
    try {
      const { code } = await run(["--root", root, "dev", "generate", "--nodes", "6", "--force"]);
      expect(code).toBe(0);
      const ids = (await listJson(root)).map((n) => n.id);
      expect(ids).toHaveLength(7);
      expect(ids).toContain("DEADBEEF");
      const validate = await run(["--root", root, "validate"]);
      expect(validate.code).toBe(0);
    } finally {
      await removeRefino(root);
    }
  });
});
