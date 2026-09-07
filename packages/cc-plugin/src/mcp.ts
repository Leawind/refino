import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRefinoServer } from "./server.js";

/**
 * Entrypoint of the plugin's MCP server: resolve the project directory from
 * the environment (the host sets the working directory to the workspace),
 * build the server and serve it over stdio.
 */

const projectDir =
  process.env.REFINO_PROJECT_DIR ??
  process.env.CLAUDE_PROJECT_DIR ??
  process.env.ZCODE_PROJECT_DIR ??
  process.cwd();

const server = createRefinoServer({ projectDir });
server.onerror = (error) => {
  process.stderr.write(`refino mcp server error: ${String(error)}\n`);
};
const transport = new StdioServerTransport();
await server.connect(transport);
