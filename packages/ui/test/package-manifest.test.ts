import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The published artifact is the Vite build under `dist/`, not a Vue component
 * library: every framework dependency is build-time only. Declaring them as
 * runtime dependencies would make `@refino/cli`'s install pull the whole
 * frontend toolchain even though the built assets are self-contained.
 */
describe("published package manifest", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    exports: Record<string, string>;
    files: string[];
    dependencies?: Record<string, string>;
  };

  it("exports only the static build", () => {
    expect(manifest.exports).toEqual({
      "./static": "./dist",
      "./package.json": "./package.json",
    });
    expect(manifest.files).toContain("dist");
  });

  it("declares no runtime dependencies", () => {
    expect(manifest.dependencies ?? {}).toEqual({});
  });
});
