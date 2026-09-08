import { readFile } from "node:fs/promises";
import { parseSignedAuthorization } from "./authorization.js";
import type { SignedAuthorization } from "./authorization.js";

/**
 * The orchestrator credential lane of the plugin form (docs/design.md,
 * "审核状态的作用域"): an orchestrator hands each task a signed authorization
 * document by path via the `REFINO_AUTHORIZATION` environment variable, and
 * the plugin resolves it at its session boundary. The conversation lane —
 * the plugin's in-session signings — lives with the plugin, not here.
 *
 * Node-only by necessity (fs) and exported as the `@refino/harness/state`
 * subpath so the platform-agnostic main entry stays browser-safe.
 */

/** Explicit orchestrator credential, from the process environment. */
export function orchestratorCredential(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.REFINO_AUTHORIZATION;
}

/**
 * Read and parse an orchestrator credential file. The credential is the one
 * authorization artifact the plugin consumes (never produces), so the tool
 * side stays file-free while orchestrated tasks still receive their per-task
 * context.
 */
export async function readAuthorizationDocument(path: string): Promise<SignedAuthorization> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `cannot read authorization document at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  try {
    return parseSignedAuthorization(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `invalid authorization document at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
