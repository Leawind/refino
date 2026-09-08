import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGraph } from "refino";
import type { Graph, NodeType, RefinoNode } from "refino";
import { convergeAuthorization } from "../src/authorization.js";
import { orchestratorCredential, readAuthorizationDocument } from "../src/state.js";

function node(id: string, type: NodeType, grounds?: string[]): RefinoNode {
  if (type === "premise") return { id, type: "premise", summary: "Body." };
  return { id, type: "constraint", summary: "Body.", grounds: grounds ?? [] };
}

function graphOf(): Graph {
  return buildGraph([
    node("1A2B3C4D", "premise"),
    node("A1B2C3D4", "constraint"),
    node("D4E5F6G7", "constraint", ["1A2B3C4D", "A1B2C3D4"]),
    node("Z9Y8X7W6", "constraint"),
  ]);
}

let home = "";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "refino-cred-"));
});

afterEach(async () => {
  delete process.env.REFINO_AUTHORIZATION;
  await rm(home, { recursive: true, force: true });
});

describe("orchestratorCredential", () => {
  it("takes the credential from REFINO_AUTHORIZATION", () => {
    expect(orchestratorCredential()).toBeUndefined();
    process.env.REFINO_AUTHORIZATION = "/tmp/cred.json";
    expect(orchestratorCredential()).toBe("/tmp/cred.json");
  });
});

describe("readAuthorizationDocument", () => {
  it("parses a well-shaped credential file", async () => {
    const path = join(home, "cred.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        signedAt: "2026-09-06T08:30:00.000Z",
        revision: 7,
        frozenFrontier: ["D4E5F6G7"],
      }),
    );
    const doc = await readAuthorizationDocument(path);
    expect(doc.revision).toBe(7);
    expect(doc.frozenFrontier).toEqual(["D4E5F6G7"]);
    // Convergence against the live graph stays a caller step.
    const converged = convergeAuthorization(graphOf(), doc);
    expect(converged.frozenFrontier).toEqual(["D4E5F6G7"]);
  });

  it("reports I/O and schema failures with the file path", async () => {
    await expect(readAuthorizationDocument(join(home, "missing.json"))).rejects.toThrow(
      /cannot read authorization document/,
    );
    const path = join(home, "bad.json");
    await writeFile(path, "{ not json", "utf8");
    await expect(readAuthorizationDocument(path)).rejects.toThrow(/invalid authorization document/);
  });
});
