import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebApp, resolveUiStaticRoot } from "../src/web/server.js";

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
});
