import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";
import { main } from "../src/main.js";
import type { CliIo } from "../src/format.js";

/**
 * Bootstrap commands: init, context, search, guide, skill. Uses its own
 * REFINO_HOME so context's workspace-state resolution cannot leak between
 * files.
 */
const P1 = "1A2B3C4D";
const A1 = "A1B2C3D4";
const D4 = "D4E5F6G7";
const Z9 = "Z9Y8X7W6";

let home: string;
let graphRoot: string;
let bareRoot: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "refino-home-"));
  process.env.REFINO_HOME = home;
  graphRoot = await createRefino({
    "nodes/1A/2B3C4D-premise.md": premise(P1, "PostgreSQL 16 is in use."),
    "nodes/A1/B2C3D4-constraint.md": constraint(A1, undefined, "All data lives in PostgreSQL."),
    "nodes/D4/E5F6G7-constraint.md": constraint(D4, [P1, A1], "Access goes through repositories."),
    "nodes/Z9/Y8X7W6-constraint.md": constraint(Z9, undefined, "No stored procedures."),
  });
  bareRoot = await mkdtemp(join(tmpdir(), "refino-bare-"));
});

afterAll(async () => {
  await removeRefino(graphRoot);
  await rm(bareRoot, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  delete process.env.REFINO_HOME;
});

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (text: string) => void out.push(text) },
    stderr: { write: (text: string) => void err.push(text) },
  };
  const code = await main(argv, io);
  return { code, out: out.join(""), err: err.join("") };
}

describe("refino init", () => {
  it("creates the skeleton and refuses an existing .refino", async () => {
    const { code, out } = await run(["--root", bareRoot, "init"]);
    expect(code).toBe(0);
    expect(out).toContain("initialized");
    await expect(readFile(join(bareRoot, ".refino", "nodes"), "utf8")).rejects.toMatchObject({
      code: "EISDIR",
    });

    const again = await run(["--root", bareRoot, "init"]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("already exists");
  });

  it("emits JSON with --json", async () => {
    const jsonRoot = await mkdtemp(join(tmpdir(), "refino-json-"));
    try {
      const { code, out } = await run(["--root", jsonRoot, "--json", "init"]);
      expect(code).toBe(0);
      const payload = JSON.parse(out) as { refinoDir: string; created: boolean };
      expect(payload.created).toBe(true);
      expect(payload.refinoDir).toBe(join(jsonRoot, ".refino"));
    } finally {
      await rm(jsonRoot, { recursive: true, force: true });
    }
  });
});

describe("refino context", () => {
  it("renders the default authorization context with guidance", async () => {
    const { code, out } = await run(["--root", graphRoot, "context"]);
    expect(code).toBe(0);
    expect(out).toContain("# CRG 授权上下文（revision 0，来源：默认");
    expect(out).toContain("## 冻结区（只读，不可修改）");
    expect(out).toContain(`${A1} [constraint]`);
    expect(out).toContain(`${Z9} [constraint]`);
    // D4 is not a root: it stays out of the frozen zone's read-only section
    // even though the default anchors cover the whole graph.
    expect(out).toContain("## 冻结区（只读，不可修改）");
    expect(out).toContain(`${D4} [constraint]`);
    expect(out.indexOf(A1)).toBeLessThan(out.indexOf("## 冻结区"));
    expect(out).not.toContain("## 冻结区（只读，不可修改）\n- D4E5F6G7");
    expect(out).toContain("refino auth apply");
    expect(out).toContain("refino guide");
  });

  it("renders JSON with anchors, frontier and estimates", async () => {
    const { code, out } = await run(["--root", graphRoot, "--json", "context"]);
    expect(code).toBe(0);
    const payload = JSON.parse(out) as {
      revision: number;
      source: string;
      anchors: string[];
      frozenFrontier: string[];
      estimate: { blocks: number; chars: number };
    };
    expect(payload.revision).toBe(0);
    expect(payload.source).toBe("default");
    expect(payload.frozenFrontier).toEqual([A1, Z9]);
    expect(payload.anchors).toContain(P1);
    expect(payload.estimate.blocks).toBeGreaterThan(0);
  });

  it("reports an unsigned delta request as unchanged", async () => {
    const { code, out } = await run(["--root", graphRoot, "context", "--since", "0"]);
    expect(code).toBe(0);
    expect(out).toContain("授权上下文自 revision 0 以来未变化");

    const bad = await run(["--root", graphRoot, "context", "--since", "-1"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("--since");
  });
});

describe("refino search", () => {
  it("matches id prefixes and summary substrings with pagination", async () => {
    const { code, out } = await run(["--root", graphRoot, "--json", "search", "PostgreSQL"]);
    expect(code).toBe(0);
    const payload = JSON.parse(out) as { nodes: Array<{ id: string }>; next_cursor?: string };
    expect(payload.nodes.map((n) => n.id)).toContain(A1);
    expect(payload.nodes.map((n) => n.id)).toContain(P1);

    const page = await run(["--root", graphRoot, "--json", "search", "--limit", "1"]);
    const paged = JSON.parse(page.out) as { nodes: Array<{ id: string }>; next_cursor?: string };
    expect(paged.nodes).toHaveLength(1);
    expect(paged.next_cursor).toBeDefined();

    const resumed = await run([
      "--root",
      graphRoot,
      "--json",
      "search",
      "--limit",
      "1",
      "--cursor",
      paged.next_cursor!,
    ]);
    const second = JSON.parse(resumed.out) as { nodes: Array<{ id: string }> };
    expect(second.nodes[0]!.id).not.toBe(paged.nodes[0]!.id);
  });

  it("supports the roots and unreferenced filters", async () => {
    const roots = await run(["--root", graphRoot, "--json", "search", "--roots"]);
    const rootIds = (JSON.parse(roots.out) as { nodes: Array<{ id: string }> }).nodes.map(
      (n) => n.id,
    );
    expect(rootIds).toEqual([A1, Z9].sort());

    const unreferenced = await run(["--root", graphRoot, "--json", "search", "--unreferenced"]);
    // P1 is grounded on by D4; the fixture has no unreferenced premise.
    const premiseIds = (JSON.parse(unreferenced.out) as { nodes: Array<{ id: string }> }).nodes.map(
      (n) => n.id,
    );
    expect(premiseIds).toEqual([]);
  });

  it("prints human-readable output and a continuation hint", async () => {
    const { code, out } = await run(["--root", graphRoot, "search", "--limit", "1"]);
    expect(code).toBe(0);
    expect(out).toContain("--cursor");
  });
});

describe("refino guide and skill", () => {
  it("guide prints the full protocol", async () => {
    const { code, out } = await run(["--root", graphRoot, "guide"]);
    expect(code).toBe(0);
    expect(out).toContain("# refino 工作协议");
    expect(out).toContain("冻结区");
    expect(out).toContain("refino context");
    expect(out).toContain("refino auth apply --dry-run");
    expect(out).toContain("git diff --name-only");
  });

  it("skill prints install guidance around the SKILL.md content", async () => {
    const { code, out } = await run(["--root", graphRoot, "skill"]);
    expect(code).toBe(0);
    expect(out).toContain("## 安装指引");
    expect(out).toContain("npx -y @refino/cli");
    expect(out).toContain("仅在仓库已有");
    expect(out).toContain("name: refino");
    expect(out).toContain("----- 8< -----");
    // Skill content is instruction-only: no project-specific data, no graph reads.
    expect(out).not.toContain(A1);
  });

  it("skill --output writes <dir>/refino/SKILL.md", async () => {
    const outDir = join(bareRoot, "skills");
    const { code, out } = await run(["--root", graphRoot, "skill", "--output", outDir]);
    expect(code).toBe(0);
    const file = join(outDir, "refino", "SKILL.md");
    expect(await readFile(file, "utf8")).toContain("name: refino");
    expect(out).toContain(file);

    const { code: jsonCode, out: jsonOut } = await run([
      "--root",
      graphRoot,
      "--json",
      "skill",
      "--output",
      join(bareRoot, "skills2"),
    ]);
    expect(jsonCode).toBe(0);
    expect(jsonOut).toContain('"wrote"');
  });
});
