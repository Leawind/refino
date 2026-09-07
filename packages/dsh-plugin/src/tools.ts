import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { createQueryTools } from "./query-tools.js";
import { createSigningTools, type SigningDeps } from "./signing.js";
import { createWriteTools } from "./write-tools.js";
import type { RefinoWorkspace } from "@refino/harness/host";

/**
 * The model-facing CRG toolset for one agent: read-only queries plus the
 * validated write path. All tools resolve the agent's workspace lazily so
 * registration order never matters and disposal is a no-op lookup. Signing
 * tools join when the host provides the approval deps; hosts without an
 * approval surface fall back to `requestApproval` resolving `"unavailable"`,
 * so in practice the signing tools register whenever a session exists.
 */
export function createTools(
  get: () => RefinoWorkspace | undefined,
  signing?: SigningDeps,
): ToolDefinition[] {
  return [
    ...createQueryTools(get),
    ...createWriteTools(get),
    ...(signing ? createSigningTools(signing) : []),
  ];
}
