import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { updateText } from "@refino/harness";
import { DeltaCoalescer, RefinoWorkspace } from "@refino/harness/host";
import { findRefinoDir } from "@refino/storage";
import { enqueueUpdate } from "./queue.js";
import { createToolTable } from "./tools.js";
import { MCP_SERVER_NAME } from "./tool-names.js";

/**
 * MCP server wiring over the CRG tool table: list/call handlers, the lazily
 * opened watched workspace, and the queue lane for external-change deltas
 * (no push channel exists, so the UserPromptSubmit hook drains the queue).
 */

const SERVER_VERSION = "0.0.1";
/** Minimum spacing between queued external-change updates (delta 降噪). */
const EXTERNAL_SYNC_INTERVAL_MS = 2000;

// ---- server wiring ----

export interface ServerOptions {
  /** The directory whose ancestors are searched for `.refino/`. */
  projectDir: string;
  env?: NodeJS.ProcessEnv;
}

/** Build the MCP server over a lazily opened workspace. */
export function createRefinoServer(options: ServerOptions): Server {
  let refinoDir: string | undefined;
  let opened: Promise<RefinoWorkspace | undefined> | undefined;
  const openWorkspace = async (): Promise<RefinoWorkspace | undefined> => {
    refinoDir ??= await findRefinoDir(options.projectDir);
    if (refinoDir === undefined) return undefined;
    const dir = refinoDir;
    const coalescer = new DeltaCoalescer(
      EXTERNAL_SYNC_INTERVAL_MS,
      (delta, changed, deleted, pending) => {
        const text = updateText(delta, changed, deleted, pending);
        if (text !== undefined) void enqueueUpdate(dir, text);
      },
    );
    return RefinoWorkspace.open(dir, (outcome) => coalescer.push(outcome));
  };

  const table = createToolTable({
    obtainWorkspace: () => (opened ??= openWorkspace()),
    deliver: (text) => {
      if (text !== undefined && refinoDir !== undefined) void enqueueUpdate(refinoDir, text);
    },
    env: options.env,
  });
  const byName = new Map(table.map((tool) => [tool.name, tool]));

  const server = new Server(
    { name: MCP_SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: table.map(({ name, description, inputSchema }): Tool => ({
      name,
      description,
      inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = byName.get(request.params.name);
    if (tool === undefined) {
      return errorResult(`未知工具：${request.params.name}`);
    }
    try {
      const args =
        typeof request.params.arguments === "object" && request.params.arguments !== null
          ? (request.params.arguments as Record<string, unknown>)
          : {};
      const value = await tool.execute(args);
      return { content: [{ type: "text", text: tool.render(value) }] };
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  return server;
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}
