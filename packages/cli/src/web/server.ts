import { existsSync, readFileSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { serve, type ServerType } from "@hono/node-server";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import {
  getGraph,
  getNode,
  getValidate,
  postConstraint,
  postPremise,
  postReload,
  putNode,
  removeNode,
  errorResponse,
} from "./api.js";
import {
  getSearch,
  postQueryGrounds,
  postQueryNeighbors,
  postQueryRange,
  postQuerySiblings,
} from "./query-api.js";
import { GraphIndex } from "./graph-index.js";
import type { ChangeEvent } from "./graph-index.js";
import { startNodeWatcher, type NodeWatcher } from "@refino/storage";

export interface WebServerOptions {
  host: string;
  port: number;
  refinoDir: string;
  /** Quiet period for external file-event debouncing; 500ms per design. */
  watchDebounceMs?: number;
}

export interface RunningWebServer {
  server: ServerType;
  url: string;
}

export interface WebAppOptions extends Partial<Pick<WebServerOptions, "refinoDir">> {
  /**
   * Absolute path of the directory holding the built `@refino/ui` assets.
   * `null` disables static hosting (placeholder page only); when omitted the
   * installed `@refino/ui` package is located and used if it has been built.
   */
  staticRoot?: string | null;
  /** Quiet period for external file-event debouncing; 500ms per design. */
  watchDebounceMs?: number;
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

interface WebParts {
  app: Hono;
  index?: GraphIndex;
  /** Begin watching `.refino/nodes/` for external writes; silently degrades. */
  startWatching(): NodeWatcher | undefined;
}

function createWeb(options: WebAppOptions): WebParts {
  const app = new Hono();
  const index = options.refinoDir !== undefined ? new GraphIndex(options.refinoDir) : undefined;

  const unavailable = (c: Context): Response =>
    c.json({ error: "API is unavailable without a .refino directory." }, 500);

  /** Loads the index once, then dispatches; load failures surface as API errors. */
  const api =
    (
      handler: (c: Context, index: GraphIndex) => Promise<Response>,
    ): ((c: Context) => Promise<Response>) =>
    async (c) => {
      if (index === undefined) return unavailable(c);
      try {
        await index.ready();
      } catch (error) {
        return errorResponse(c, error);
      }
      return handler(c, index);
    };

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get(
    "/api/graph",
    api((c, index) => getGraph(c, index)),
  );
  app.get(
    "/api/validate",
    api((c, index) => getValidate(c, index)),
  );
  app.get(
    "/api/nodes/:id",
    api((c, index) => getNode(c, index)),
  );
  app.post(
    "/api/nodes/premise",
    api((c, index) => postPremise(c, index)),
  );
  app.post(
    "/api/nodes/constraint",
    api((c, index) => postConstraint(c, index)),
  );
  app.put(
    "/api/nodes/:id",
    api((c, index) => putNode(c, index)),
  );
  app.delete(
    "/api/nodes/:id",
    api((c, index) => removeNode(c, index)),
  );
  app.post(
    "/api/reload",
    api((c, index) => postReload(c, index)),
  );
  app.post(
    "/api/query/neighbors",
    api((c, index) => postQueryNeighbors(c, index)),
  );
  app.post(
    "/api/query/grounds",
    api((c, index) => postQueryGrounds(c, index)),
  );
  app.post(
    "/api/query/range",
    api((c, index) => postQueryRange(c, index)),
  );
  app.post(
    "/api/query/siblings",
    api((c, index) => postQuerySiblings(c, index)),
  );
  app.get(
    "/api/search",
    api((c, index) => getSearch(c, index)),
  );

  // SSE change feed: an initial snapshot event, then one event per applied
  // change batch. Reconnecting clients compare revisions and refresh
  // wholesale (docs/design.md, "外部变更同步").
  app.get("/api/events", (c) => {
    if (index === undefined) return unavailable(c);
    return streamSSE(c, async (stream) => {
      let open = true;
      const send = (event: ChangeEvent): void => {
        if (!open) return;
        void stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {
          open = false;
        });
      };
      try {
        await index.ready();
      } catch {
        return; // a broken store ends the stream instead of hanging it
      }
      const unsubscribe = index.subscribe(send);
      stream.onAbort(() => {
        open = false;
        unsubscribe();
      });
      send({ revision: index.revision, changed: [], deleted: [], reload: true });
      while (!stream.aborted) await stream.sleep(200);
    });
  });

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

  return {
    app,
    index,
    startWatching(): NodeWatcher | undefined {
      if (index === undefined || options.refinoDir === undefined) return undefined;
      void index.ready().catch(() => {}); // watcher events may arrive before the first request
      return startNodeWatcher(
        join(options.refinoDir, "nodes"),
        (ids, shards) => void index.applyChange({ changed: ids, shards }),
        { debounceMs: options.watchDebounceMs },
      );
    },
  };
}

/** Build the web application. Pure object, no listening socket — easy to test. */
export function createWebApp(options: WebAppOptions = {}): Hono {
  return createWeb(options).app;
}

function readIndexHtml(staticRoot: string): string {
  const index = join(staticRoot, "index.html");
  if (existsSync(index)) return readFileSync(index, "utf8");
  return placeholderPage();
}

/** Start the HTTP server (with external-change watching); resolve only when the socket is accepting. */
export function startWebServer(options: WebServerOptions): Promise<RunningWebServer> {
  const { host, port, refinoDir } = options;
  const parts = createWeb({ refinoDir, watchDebounceMs: options.watchDebounceMs });
  const watcher = parts.startWatching();
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: parts.app.fetch, hostname: host, port }, (info) => {
      // The watchers keep the event loop alive; release them with the server.
      server.on("close", () => watcher?.close());
      resolve({ server, url: `http://${host}:${info.port}` });
    });
    server.on("error", reject);
  });
}
