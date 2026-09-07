import { readFile } from "node:fs/promises";
import { parseSignedAuthorization } from "./authorization.js";
import type { SignedAuthorization } from "./authorization.js";

/**
 * The orchestrator credential lane (docs/design.md, "授权状态的作用域"): an
 * orchestrator hands each task a signed authorization document by path
 * (the `--authorization` flag or the `REFINO_AUTHORIZATION` environment
 * variable), and consumers resolve it at their session/command boundary.
 * This is the only state-lane piece shared across integration forms — the
 * conversation lanes belong to the forms themselves (the CLI's user-level
 * workspace state, the plugin's in-session signings), so they live with
 * their owners, not here.
 *
 * Node-only by necessity (fs) and exported as the `@refino/harness/state`
 * subpath so the platform-agnostic main entry stays browser-safe.
 */

/** What a consumer tells the resolver about itself. */
export interface AuthorizationRequest {
  /** Explicit orchestrator credential path (CLI `--authorization`). */
  authorization?: string;
}

/** Explicit orchestrator credential, by request field or environment. */
export function orchestratorCredential(
  req: Pick<AuthorizationRequest, "authorization">,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return req.authorization ?? env.REFINO_AUTHORIZATION;
}

/**
 * Read and parse an orchestrator credential file. Shared by every
 * integration form: the credential is the one authorization artifact the
 * plugin consumes (never produces), so the tool side stays file-free while
 * orchestrated tasks still receive their per-task context.
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
