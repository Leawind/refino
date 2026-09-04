import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { createQueryTools } from "./query-tools.js";
import { createWriteTools } from "./write-tools.js";
import type { RefinoWorkspace } from "./workspace.js";

/**
 * The model-facing CRG toolset for one agent: read-only queries plus the
 * validated write path. All tools resolve the agent's workspace lazily so
 * registration order never matters and disposal is a no-op lookup.
 */
export function createTools(get: () => RefinoWorkspace | undefined): ToolDefinition[] {
  return [...createQueryTools(get), ...createWriteTools(get)];
}
