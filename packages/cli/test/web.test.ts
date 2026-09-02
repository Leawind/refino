import { describe, expect, it } from "vitest";
import { createWebApp } from "../src/web/server.js";

describe("refino web", () => {
  const app = createWebApp();

  it("serves a placeholder page at /", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("refino web");
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
