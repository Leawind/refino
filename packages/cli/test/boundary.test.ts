import { describe, expect, it } from "vitest";
import {
  A1,
  D4,
  P1,
  P2,
  Z9,
  clearOrchestratorCredential,
  root,
  run,
  useOrchestratorCredential,
  writeCredentialFile,
} from "./authorization-fixture.js";

describe("write-path boundary enforcement", () => {
  it("refuses updating a root constraint under the default authorization", async () => {
    const { code, out } = await run(["--root", root(), "update", A1, "--body", "Rewritten."]);
    expect(code).toBe(1);
    expect(out).toContain(`越界：节点 ${A1} 位于冻结区，修改被拒绝。`);
    expect(out).toContain(`被冻结 frontier ${A1} 覆盖`);
    expect(out).toContain("refino auth apply --dry-run");
  });

  it("reports affected downstream constraints and covering frontier in the escalation", async () => {
    const { out } = await run(["--root", root(), "--json", "update", A1, "--body", "x"]);
    // Structured report: A1 is a frontier node itself, D4 hangs downstream.
    const payload = JSON.parse(out) as {
      blocked: { coveringFrontier: string[]; affected: Array<{ id: string; depth: number }> };
    };
    expect(payload.blocked.coveringFrontier).toEqual([A1]);
    expect(payload.blocked.affected).toEqual([{ id: D4, depth: 1 }]);
  });

  it("freezes a premise only as an ancestor of a signed frontier constraint", async () => {
    await useOrchestratorCredential([D4]);
    try {
      // Zone of D4: D4, P1, A1 — P1 joins the zone as an ancestor, covering
      // frontier is D4 (the signed node), not the premise itself.
      const { code, out } = await run(["--root", root(), "update", P1, "--body", "x"]);
      expect(code).toBe(1);
      expect(out).toContain(`被冻结 frontier ${D4} 覆盖`);
      expect(out).toContain(P1);

      // P2 stays outside every zone: modifiable.
      const other = await run(["--root", root(), "update", P2, "--body", "x"]);
      expect(other.code).toBe(0);
    } finally {
      clearOrchestratorCredential();
    }
  });

  it("refuses deleting a frozen node; --force does not bypass authorization", async () => {
    const plain = await run(["--root", root(), "delete", A1]);
    expect(plain.code).toBe(1);
    expect(plain.out).toContain("frozen by authorization");

    const forced = await run(["--root", root(), "delete", A1, "--force"]);
    expect(forced.code).toBe(1);
    expect(forced.out).toContain("frozen by authorization");
  });

  it("keeps nodes outside the frozen zone modifiable", async () => {
    const premise = await run(["--root", root(), "update", P1, "--body", "Updated fact."]);
    expect(premise.code).toBe(0);

    const refinement = await run(["--root", root(), "delete", D4]);
    expect(refinement.code).toBe(0);

    // The other root is still frozen: the zone covers all roots by default.
    const otherRoot = await run(["--root", root(), "update", Z9, "--body", "Rewritten."]);
    expect(otherRoot.code).toBe(1);
  });

  it("defers to an orchestrator credential instead of the default", async () => {
    await useOrchestratorCredential([]);
    try {
      const { code, out } = await run(["--root", root(), "update", A1, "--body", "Rewritten."]);
      expect(code).toBe(0);
      expect(out).toContain(`updated ${A1}`);
    } finally {
      clearOrchestratorCredential();
    }
  });

  it("prefers the explicit --authorization flag over the environment", async () => {
    await useOrchestratorCredential([A1]); // env credential keeps A1 frozen
    try {
      const envBlocked = await run(["--root", root(), "update", A1, "--body", "x"]);
      expect(envBlocked.code).toBe(1);

      // The flag credential with an empty frontier unfreezes everything and
      // takes precedence over the environment credential.
      const flagPath = await writeCredentialFile([]);
      const flagAllowed = await run([
        "--root",
        root(),
        "--authorization",
        flagPath,
        "update",
        A1,
        "--body",
        "Rewritten via flag.",
      ]);
      expect(flagAllowed.code).toBe(0);
    } finally {
      clearOrchestratorCredential();
    }
  });
});

describe("read-side frozen annotation", () => {
  // Frontier [A1]: the zone is {A1} alone, independent of any other node's
  // fate in earlier tests of this file (some delete or update nodes).
  it("marks frozen nodes in show output; unfrozen records stay unlabeled", async () => {
    await useOrchestratorCredential([A1]);
    try {
      const frozen = await run(["--root", root(), "show", A1]);
      expect(frozen.code).toBe(0);
      expect(frozen.out).toContain("frozen: true");

      const modifiable = await run(["--root", root(), "show", Z9]);
      expect(modifiable.code).toBe(0);
      expect(modifiable.out).not.toContain("frozen: true");
    } finally {
      clearOrchestratorCredential();
    }
  });

  it("carries the frozen field in JSON and the mark in table output", async () => {
    await useOrchestratorCredential([A1]);
    try {
      const show = await run(["--root", root(), "--json", "show", A1, Z9]);
      const groups = JSON.parse(show.out) as Array<{
        id: string;
        results: Array<{ id: string; frozen: boolean }>;
      }>;
      const byQueried = new Map(groups.map((g) => [g.id, g.results[0]!]));
      expect(byQueried.get(A1)!.frozen).toBe(true);
      expect(byQueried.get(Z9)!.frozen).toBe(false);

      const listed = await run(["--root", root(), "list"]);
      expect(listed.out).toContain("[冻结]");
    } finally {
      clearOrchestratorCredential();
    }
  });
});
