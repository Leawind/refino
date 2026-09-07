import { build } from "esbuild";

// Bundles for the plugin artifacts: the host launches them with plain `node`
// from the installed plugin directory, so every dependency (the workspace
// packages and the MCP SDK) is inlined into single self-contained files.
const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  // Bundled CommonJS deps (e.g. `yaml`) call require() for node builtins;
  // in ESM output esbuild's shim throws unless a real `require` exists.
  banner: {
    js: "import { createRequire as refinoCreateRequire } from 'node:module'; const require = refinoCreateRequire(import.meta.url);",
  },
  logLevel: "info",
};

await build({ ...shared, entryPoints: ["src/mcp.ts"], outfile: "dist/mcp.js" });
await build({ ...shared, entryPoints: ["src/hook.ts"], outfile: "dist/hook.js" });
