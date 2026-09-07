import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";
import { main } from "../src/main.js";
import type { CliIo } from "../src/format.js";

/**
 * Shared fixture for the authorization-related suites: REFINO_HOME is
 * redirected into a temp dir so workspace state never touches the real home,
 * and the graph has two roots so the default frozen zone covers more than
 * one node. Root constraints have no grounds by definition, so premises are
 * never frozen by default — only by an explicit signing (frontier D4 pulls
 * P1 into the zone as an ancestor).
 *
 *   1A2B3C4D (premise) ──┬→ D4E5F6G7
 *   A1B2C3D4 (root) ─────┘
 *   2B3C4D5E (premise, unreferenced)
 *   Z9Y8X7W6 (standalone root)
 */
export const P1 = "1A2B3C4D";
export const P2 = "2B3C4D5E";
export const A1 = "A1B2C3D4";
export const D4 = "D4E5F6G7";
export const Z9 = "Z9Y8X7W6";

let home = "";
let rootDir = "";

/** The fixture project root; valid only inside test runs (beforeAll sets it). */
export function root(): string {
  return rootDir;
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "refino-home-"));
  process.env.REFINO_HOME = home;
  rootDir = await createRefino({
    "nodes/1A/2B3C4D-premise.md": premise(P1, "P1 fact."),
    "nodes/2B/3C4D5E-premise.md": premise(P2, "P2 fact."),
    "nodes/A1/B2C3D4-constraint.md": constraint(A1, undefined, "A1 decision."),
    "nodes/D4/E5F6G7-constraint.md": constraint(D4, [P1, A1], "D4 decision."),
    "nodes/Z9/Y8X7W6-constraint.md": constraint(Z9, undefined, "Z9 decision."),
  });
});

afterAll(async () => {
  await removeRefino(rootDir);
  await rm(home, { recursive: true, force: true });
  delete process.env.REFINO_HOME;
  delete process.env.REFINO_AUTHORIZATION;
});

/** Write an orchestrator credential file; returns its path. */
export async function writeCredentialFile(frontier: string[]): Promise<string> {
  const file = join(
    home,
    `credential-${frontier.length}-${Math.random().toString(36).slice(2)}.json`,
  );
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      signedAt: "2026-09-06T08:30:00.000Z",
      revision: 7,
      frozenFrontier: frontier,
    }),
  );
  return file;
}

/** Point REFINO_AUTHORIZATION at a freshly written orchestrator credential. */
export async function useOrchestratorCredential(frontier: string[]): Promise<void> {
  process.env.REFINO_AUTHORIZATION = await writeCredentialFile(frontier);
}

export function clearOrchestratorCredential(): void {
  delete process.env.REFINO_AUTHORIZATION;
}

export async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (text: string) => void out.push(text) },
    stderr: { write: (text: string) => void err.push(text) },
  };
  const code = await main(argv, io);
  return { code, out: out.join(""), err: err.join("") };
}
