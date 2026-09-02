import { existsSync, readFileSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { serve, type ServerType } from "@hono/node-server";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import { getGraph, postPremise, postConstraint, putNode, removeNode, getValidate } from "./api.js";
import type { GraphApiOptions } from "./api.js";

export interface WebServerOptions {
  host: string;
  port: number;
  refinoDir: string;
}

export interface RunningWebServer {
  server: ServerType;
  url: string;
}

export interface WebAppOptions extends Partial<GraphApiOptions> {
  /**
   * Absolute path of the directory holding the built `@refino/ui` assets.
   * `null` disables static hosting (placeholder page only); when omitted the
   * installed `@refino/ui` package is located and used if it has been built.
   */
  staticRoot?: string | null;
}

/** Placeholder page shown until the real web UI exists. */
function placeholderPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>refino web</title>
<style>body{font-family:sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}</style>
</head>
<body>
<main>
<h1>refino web</h1>
<p>The web UI is not implemented yet.</p>
</main>
</body>
</html>
`;
}

/**
 * Locate the built assets of the installed `@refino/ui` package, or return
 * `undefined` when the package is absent or has not been built yet.
 */
export function resolveUiStaticRoot(from: string): string | undefined {
  try {
    const pkg = createRequire(from).resolve("@refino/ui/package.json");
    const dist = join(dirname(pkg), "dist");
    return existsSync(dist) ? dist : undefined;
  } catch {
    return undefined;
  }
}

/** Build the web application. Pure object, no listening socket — easy to test. */
export function createWebApp(options: WebAppOptions = {}): Hono {
  const app = new Hono();

  const api =
    (handler: (c: Context) => Promise<Response>): ((c: Context) => Promise<Response>) =>
    async (c) => {
      if (options.refinoDir === undefined) {
        return c.json({ error: "API is unavailable without a .refino directory." }, 500);
      }
      return handler(c);
    };

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get(
    "/api/graph",
    api((c) => getGraph(c, options as GraphApiOptions)),
  );
  app.get(
    "/api/validate",
    api((c) => getValidate(c, options as GraphApiOptions)),
  );
  app.post(
    "/api/nodes/premise",
    api((c) => postPremise(c, options as GraphApiOptions)),
  );
  app.post(
    "/api/nodes/constraint",
    api((c) => postConstraint(c, options as GraphApiOptions)),
  );
  app.put(
    "/api/nodes/:id",
    api((c) => putNode(c, options as GraphApiOptions)),
  );
  app.delete(
    "/api/nodes/:id",
    api((c) => removeNode(c, options as GraphApiOptions)),
  );

  const staticRoot =
    options.staticRoot === undefined
      ? resolveUiStaticRoot(import.meta.url)
      : (options.staticRoot ?? undefined);

  if (staticRoot === undefined) {
    app.get("/", (c) => c.html(placeholderPage()));
  } else {
    app.use("*", serveStatic({ root: staticRoot }));
    // SPA fallback: unmatched GET requests get the app shell.
    app.get("*", (c) => c.html(readIndexHtml(staticRoot)));
  }
  return app;
}

function readIndexHtml(staticRoot: string): string {
  const index = join(staticRoot, "index.html");
  if (existsSync(index)) return readFileSync(index, "utf8");
  return placeholderPage();
}

/** Start the HTTP server; resolve only when the socket is accepting. */
export function startWebServer(options: WebServerOptions): Promise<RunningWebServer> {
  const { host, port, refinoDir } = options;
  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: createWebApp({ refinoDir }).fetch, hostname: host, port },
      (info) => {
        resolve({ server, url: `http://${host}:${info.port}` });
      },
    );
    server.on("error", reject);
  });
}
