import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";

export interface WebServerOptions {
  host: string;
  port: number;
}

export interface RunningWebServer {
  server: ServerType;
  url: string;
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

/** Build the web application. Pure object, no listening socket — easy to test. */
export function createWebApp(): Hono {
  const app = new Hono();
  app.get("/", (c) => c.html(placeholderPage()));
  app.get("/api/health", (c) => c.json({ ok: true }));
  return app;
}

/** Start the HTTP server; resolve only when the socket is accepting. */
export function startWebServer(options: WebServerOptions): Promise<RunningWebServer> {
  const { host, port } = options;
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: createWebApp().fetch, hostname: host, port }, (info) => {
      resolve({ server, url: `http://${host}:${info.port}` });
    });
    server.on("error", reject);
  });
}
