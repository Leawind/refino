import { existsSync, readFileSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { serve, type ServerType } from "@hono/node-server";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import { RefinoStore, type StoreChange } from "@refino/storage";
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
  getStats,
  getPending,
  postQueryGrounds,
  postQueryNeighbors,
  postQueryRange,
  postQuerySiblings,
} from "./query-api.js";
import { WebState } from "./web-state.js";

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
  web?: WebState;
}

function createWeb(options: WebAppOptions): WebParts {
  const app = new Hono();
  const web =
    options.refinoDir !== undefined
      ? new WebState(
          RefinoStore.open(options.refinoDir, {
            watch: { debounceMs: options.watchDebounceMs ?? 500 },
          }),
        )
      : undefined;

  const unavailable = (c: Context): Response =>
    c.json({ error: "API is unavailable without a .refino directory." }, 500);

  /** Loads the store once, then dispatches; load failures surface as API errors. */
  const api =
    (
      handler: (c: Context, web: WebState) => Promise<Response>,
    ): ((c: Context) => Promise<Response>) =>
    async (c) => {
      if (web === undefined) return unavailable(c);
      try {
        await web.store.ready();
      } catch (error) {
        return errorResponse(c, error);
      }
      return handler(c, web);
    };

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get(
    "/api/graph",
    api((c, web) => getGraph(c, web)),
  );
  app.get(
    "/api/validate",
    api((c, web) => getValidate(c, web)),
  );
  app.get(
    "/api/nodes/:id",
    api((c, web) => getNode(c, web)),
  );
  app.post(
    "/api/nodes/premise",
    api((c, web) => postPremise(c, web)),
  );
  app.post(
    "/api/nodes/constraint",
    api((c, web) => postConstraint(c, web)),
  );
  app.put(
    "/api/nodes/:id",
    api((c, web) => putNode(c, web)),
  );
  app.delete(
    "/api/nodes/:id",
    api((c, web) => removeNode(c, web)),
  );
  app.post(
    "/api/reload",
    api((c, web) => postReload(c, web)),
  );
  app.post(
    "/api/query/neighbors",
    api((c, web) => postQueryNeighbors(c, web)),
  );
  app.post(
    "/api/query/grounds",
    api((c, web) => postQueryGrounds(c, web)),
  );
  app.post(
    "/api/query/range",
    api((c, web) => postQueryRange(c, web)),
  );
  app.post(
    "/api/query/siblings",
    api((c, web) => postQuerySiblings(c, web)),
  );
  app.get(
    "/api/search",
    api((c, web) => getSearch(c, web)),
  );
  app.get(
    "/api/stats",
    api((c, web) => getStats(c, web)),
  );
  app.get(
    "/api/pending",
    api((c, web) => getPending(c, web)),
  );

  // SSE change feed: an initial snapshot event, then one event per applied
  // change batch. Reconnecting clients compare revisions and refresh
  // wholesale (docs/design.md, "外部变更同步"). The wire event keeps the
  // documented shape: affected stays store-internal (it feeds /api/pending).
  app.get("/api/events", (c) => {
    if (web === undefined) return unavailable(c);
    return streamSSE(c, async (stream) => {
      let open = true;
      const send = (change: StoreChange): void => {
        if (!open) return;
        const event = toWireEvent(change);
        void stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {
          open = false;
        });
      };
      try {
        await web.store.ready();
      } catch {
        return; // a broken store ends the stream instead of hanging it
      }
      const unsubscribe = web.store.onChange(send);
      stream.onAbort(() => {
        open = false;
        unsubscribe();
      });
      send({
        revision: web.store.revision,
        changed: [],
        deleted: [],
        affected: [],
        reload: true,
      });
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

  return { app, web };
}

/**
 * The SSE wire event: the documented shape (docs/design.md, "外部变更同步").
 * The change's `affected` stays store-internal — it feeds /api/pending, not
 * the client feed.
 */
function toWireEvent(change: StoreChange): Omit<StoreChange, "affected"> {
  return {
    revision: change.revision,
    changed: change.changed,
    deleted: change.deleted,
    ...(change.origin !== undefined && { origin: change.origin }),
    ...(change.reload !== undefined && { reload: change.reload }),
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

/** Start the HTTP server (with external-change watching inside the store); resolve only when the socket is accepting. */
export function startWebServer(options: WebServerOptions): Promise<RunningWebServer> {
  const { host, port } = options;
  const parts = createWeb({
    refinoDir: options.refinoDir,
    watchDebounceMs: options.watchDebounceMs,
  });
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: parts.app.fetch, hostname: host, port }, (info) => {
      // The store's watcher keeps the event loop alive; release it with the server.
      server.on("close", () => parts.web?.close());
      resolve({ server, url: `http://${host}:${info.port}` });
    });
    server.on("error", reject);
  });
}
