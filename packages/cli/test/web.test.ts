import { createServer as createHttpServer, type ServerType } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createWebApp,
  DEFAULT_WEB_PORT,
  resolveUiStaticRoot,
  startWebServer,
} from "../src/web/server.js";
import type { RunningWebServer } from "../src/web/server.js";
import { createRefino, premise, removeRefino } from "@refino/testkit";

describe("refino web", () => {
  describe("without static assets", () => {
    const app = createWebApp({ staticRoot: null });

    it("serves a placeholder page at /", async () => {
      const res = await app.request("/");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("The web UI is not implemented yet.");
    });

    it("reports health as JSON", async () => {
      const res = await app.request("/api/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it("returns 404 for unknown paths", async () => {
      const res = await app.request("/nope");
      expect(res.status).toBe(404);
    });
  });

  describe("with static assets", () => {
    let staticRoot: string;

    beforeAll(async () => {
      staticRoot = await mkdtemp(join(tmpdir(), "refino-web-"));
      await writeFile(
        join(staticRoot, "index.html"),
        '<!doctype html><html><head><title>refino web</title></head><body><div id="app"></div></body></html>',
      );
      await writeFile(join(staticRoot, "app.js"), "console.log('app')");
    });

    afterAll(async () => {
      await rm(staticRoot, { recursive: true, force: true });
    });

    const app = () => createWebApp({ staticRoot });

    it("serves the built index.html at /", async () => {
      const res = await app().request("/");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<div id="app">');
    });

    it("serves static files and falls back to index.html for SPA routes", async () => {
      const js = await app().request("/app.js");
      expect(js.status).toBe(200);
      const spa = await app().request("/some/client/route");
      expect(spa.status).toBe(200);
      expect(await spa.text()).toContain('<div id="app">');
    });

    it("locates the installed @refino/ui build when present", () => {
      const root = resolveUiStaticRoot(import.meta.url);
      if (root !== undefined) {
        expect(root).toMatch(/dist$/);
      }
    });
  });

  describe("startWebServer port picking", () => {
    const host = "127.0.0.1";
    let root: string;
    /** Placeholder servers occupying ports; closed in afterAll. */
    const blockers: ServerType[] = [];
    const started: RunningWebServer[] = [];

    beforeAll(async () => {
      root = await createRefino({
        "nodes/1A/2B3C4D-premise.md": premise("1A2B3C4D", "前提一。"),
      });
    });

    afterAll(async () => {
      for (const running of started) {
        running.server.closeAllConnections?.();
        await new Promise<void>((resolve) => running.server.close(() => resolve()));
      }
      for (const blocker of blockers) {
        blocker.closeAllConnections?.();
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
      await removeRefino(root);
    });

    /** Binds a placeholder HTTP server on `port` (0 = ephemeral). */
    const occupy = (port: number): Promise<ServerType> =>
      new Promise((resolve, reject) => {
        const blocker = createHttpServer();
        blocker.once("error", reject);
        blocker.listen(port, host, () => resolve(blocker));
      });

    const portOf = (server: ServerType): number => (server.address() as { port: number }).port;

    const healthOk = async (url: string): Promise<boolean> => {
      const res = await fetch(new URL("/api/health", url));
      return res.status === 200 && (await res.json()).ok === true;
    };

    it("honors an explicit port", async () => {
      const blocker = await occupy(0);
      const free = portOf(blocker);
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      const running = await startWebServer({ host, port: free, refinoDir: join(root, ".refino") });
      started.push(running);
      expect(running.url).toBe(`http://${host}:${free}`);
      expect(await healthOk(running.url)).toBe(true);
    });

    it("bumps from the default port when it is taken", async (ctx) => {
      let blocker: ServerType;
      try {
        blocker = await occupy(DEFAULT_WEB_PORT);
      } catch {
        // The default port is held by something outside this test (e.g. a dev
        // `refino web`); the scenario needs to own it.
        ctx.skip();
        return;
      }
      blockers.push(blocker);
      const running = await startWebServer({ host, refinoDir: join(root, ".refino") });
      started.push(running);
      const picked = Number(new URL(running.url).port);
      expect(picked).toBeGreaterThan(DEFAULT_WEB_PORT);
      expect(await healthOk(running.url)).toBe(true);
    });

    it("fails on an explicit occupied port", async () => {
      const blocker = await occupy(0);
      blockers.push(blocker);
      await expect(
        startWebServer({ host, port: portOf(blocker), refinoDir: join(root, ".refino") }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    });
  });
});
