import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

const { candidateNames, isMusl, resolveBinaryPath, runBinary, missingBinaryError, withUiDir } =
  require("../bin/refino.js") as {
    candidateNames: (platform?: string, arch?: string, musl?: boolean) => string[];
    isMusl: (platform: string, report?: unknown) => boolean;
    resolveBinaryPath: (options?: {
      platform?: string;
      arch?: string;
      musl?: boolean;
      resolve?: (id: string) => string;
    }) => { path: string; packageName: string } | undefined;
    runBinary: (binaryPath: string, argv: string[], env?: NodeJS.ProcessEnv) => number;
    missingBinaryError: (candidates: string[]) => string;
    withUiDir: (
      env?: NodeJS.ProcessEnv,
      resolve?: (id: string) => string,
      exists?: (path: string) => boolean,
    ) => NodeJS.ProcessEnv;
  };

const shellManifest = require("../package.json") as {
  version: string;
  optionalDependencies: Record<string, string>;
};

/** Platform manifests are read from their repo dirs, not via require: pnpm
 * only links the optional dependencies matching the host's os/cpu, so a
 * darwin manifest must be reachable from a linux CI host by path. */
function platformManifestPath(name: string): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "../../",
    name.replace("@refino/", ""),
    "package.json",
  );
}

function readPlatformManifest(name: string): {
  version: string;
  os: string[];
  cpu: string[];
  libc?: string[];
} {
  return JSON.parse(readFileSync(platformManifestPath(name), "utf8"));
}

describe("candidateNames", () => {
  it("covers the shipped platforms and filters by arch", () => {
    expect(candidateNames("win32", "x64")).toEqual(["win32-x64"]);
    expect(candidateNames("darwin", "arm64")).toEqual(["darwin-arm64"]);
    expect(candidateNames("linux", "x64", false)).toEqual(["linux-x64", "linux-x64-musl"]);
    // a musl host prefers the musl build: glibc binaries cannot run there
    expect(candidateNames("linux", "arm64", true)).toEqual(["linux-arm64-musl", "linux-arm64"]);
    expect(candidateNames("sunos", "x64")).toEqual([]);
    expect(candidateNames("linux", "riscv64")).toEqual([]);
  });

  it("defaults to the running process platform", () => {
    const names = candidateNames();
    expect(names.every((name) => name.startsWith(`${process.platform}-`))).toBe(true);
  });
});

describe("isMusl", () => {
  it("is false off linux and when the glibc runtime version is present", () => {
    expect(isMusl("win32")).toBe(false);
    expect(isMusl("linux", { header: { glibcVersionRuntime: "2.31" } })).toBe(false);
  });

  it("is true when process.report lacks a glibc runtime version", () => {
    expect(isMusl("linux", { header: {} })).toBe(true);
  });

  // With no report passed the live process.report is read, so the answer is
  // the host's own musl-ness: glibc runners say false, musl hosts and hosts
  // without a usable report say true.
  it("falls back to the live process report when none is passed", () => {
    const live = process.report?.getReport?.();
    const liveIsMusl = live === undefined || live.header?.glibcVersionRuntime === undefined;
    expect(isMusl("linux", undefined)).toBe(liveIsMusl);
  });
});

describe("resolveBinaryPath", () => {
  /** Fake resolver: resolves only the given package-internal ids. */
  const resolverFor =
    (...resolvable: string[]) =>
    (id: string) => {
      if (!resolvable.includes(id)) throw new Error(`not found: ${id}`);
      return `/fake/${id}`;
    };

  it("resolves the matching platform package with the correct subpath", () => {
    const found = resolveBinaryPath({
      platform: "win32",
      arch: "x64",
      resolve: resolverFor("@refino/cli-win32-x64/bin/refino.exe"),
    });
    expect(found?.packageName).toBe("@refino/cli-win32-x64");
    expect(found?.path).toContain("refino.exe");
  });

  it("falls through to the second libc flavor on linux", () => {
    const found = resolveBinaryPath({
      platform: "linux",
      arch: "x64",
      musl: true,
      resolve: resolverFor("@refino/cli-linux-x64/bin/refino"),
    });
    // musl flavor missing → the gnu build is tried and wins
    expect(found?.packageName).toBe("@refino/cli-linux-x64");
  });

  it("returns undefined when nothing resolves", () => {
    expect(resolveBinaryPath({ platform: "sunos", arch: "x64" })).toBeUndefined();
    expect(
      resolveBinaryPath({
        platform: "linux",
        arch: "x64",
        musl: false,
        resolve: () => {
          throw new Error("none");
        },
      }),
    ).toBeUndefined();
  });
});

describe("manifest contract", () => {
  it("declares exactly the shipped platform packages, pinned via workspace:*", () => {
    const expected = new Set([
      "@refino/cli-darwin-arm64",
      "@refino/cli-darwin-x64",
      "@refino/cli-linux-arm64",
      "@refino/cli-linux-x64",
      "@refino/cli-win32-x64",
    ]);
    expect(new Set(Object.keys(shellManifest.optionalDependencies))).toEqual(expected);
    for (const [name, range] of Object.entries(shellManifest.optionalDependencies)) {
      // publish replaces the protocol with the exact shared version
      expect(range, name).toBe("workspace:*");
      expect(readPlatformManifest(name).version, name).toBe(shellManifest.version);
    }
  });

  it("describes each platform package's os/cpu/libc filters", () => {
    const filters: Record<string, { os: string; cpu: string; libc?: string }> = {
      "@refino/cli-darwin-arm64": { os: "darwin", cpu: "arm64" },
      "@refino/cli-darwin-x64": { os: "darwin", cpu: "x64" },
      "@refino/cli-linux-arm64": { os: "linux", cpu: "arm64", libc: "glibc" },
      "@refino/cli-linux-x64": { os: "linux", cpu: "x64", libc: "glibc" },
      "@refino/cli-win32-x64": { os: "win32", cpu: "x64" },
    };
    for (const [name, want] of Object.entries(filters)) {
      const manifest = readPlatformManifest(name);
      expect(manifest.os, name).toEqual([want.os]);
      expect(manifest.cpu, name).toEqual([want.cpu]);
      expect(manifest.libc ?? undefined, name).toEqual(want.libc ? [want.libc] : undefined);
    }
  });
});

describe("withUiDir", () => {
  it("hands the installed @refino/ui build to the child", () => {
    const env = withUiDir(
      { PATH: "/bin" },
      () => "/fake/node_modules/@refino/ui/package.json",
      (path) => path === join("/fake/node_modules/@refino/ui", "dist"),
    );
    expect(env.REFINO_UI_DIR).toBe(join("/fake/node_modules/@refino/ui", "dist"));
    expect(env.PATH).toBe("/bin");
  });

  it("keeps an explicit REFINO_UI_DIR and leaves the env alone when the build is absent", () => {
    const explicit = { REFINO_UI_DIR: "/custom/ui" };
    expect(
      withUiDir(
        explicit,
        () => "/fake/package.json",
        () => true,
      ),
    ).toBe(explicit);
    expect(
      withUiDir(
        {},
        () => "/fake/package.json",
        () => false,
      ).REFINO_UI_DIR,
    ).toBeUndefined();
    expect(
      withUiDir(
        {},
        () => {
          throw new Error("not installed");
        },
        () => true,
      ).REFINO_UI_DIR,
    ).toBeUndefined();
  });
});

describe("runBinary", () => {
  it(
    "propagates the exit code of the spawned binary",
    { skip: process.platform === "win32" },
    () => {
      const dir = mkdtempSync(join(tmpdir(), "refino-shell-"));
      const fake = join(dir, "fake-refino.sh");
      writeFileSync(fake, "#!/bin/sh\nexit 3\n");
      chmodSync(fake, 0o755);
      try {
        expect(runBinary(fake, [])).toBe(3);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("spawns with the environment it is given", { skip: process.platform === "win32" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "refino-shell-"));
    const fake = join(dir, "fake-refino.sh");
    // Exits 9 when the UI directory did not reach the child.
    writeFileSync(fake, '#!/bin/sh\n[ "$REFINO_UI_DIR" = "/fake/ui" ] || exit 9\nexit 0\n');
    chmodSync(fake, 0o755);
    try {
      expect(runBinary(fake, [], { ...process.env, REFINO_UI_DIR: "/fake/ui" })).toBe(0);
      expect(runBinary(fake, [], { ...process.env })).toBe(9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("install layout", () => {
  it(
    "finds the platform package with Node's resolver from the installed shell",
    { skip: process.platform === "win32" },
    () => {
      // A throwaway copy of the shell under node_modules/@refino/cli, with a
      // sibling platform package: the layout a global npm install produces.
      // The default resolver must work with no injection.
      const suffix = `${process.platform}-${process.arch}`;
      const dir = mkdtempSync(join(tmpdir(), "refino-shell-"));
      const shellDir = join(dir, "node_modules", "@refino", "cli");
      const platformDir = join(dir, "node_modules", "@refino", `cli-${suffix}`);
      mkdirSync(join(shellDir, "bin"), { recursive: true });
      mkdirSync(join(platformDir, "bin"), { recursive: true });
      cpSync(require.resolve("../bin/refino.js"), join(shellDir, "bin", "refino.js"));
      cpSync(require.resolve("../package.json"), join(shellDir, "package.json"));
      writeFileSync(
        join(platformDir, "package.json"),
        JSON.stringify({ name: `@refino/cli-${suffix}`, version: shellManifest.version }),
      );
      const fake = join(platformDir, "bin", "refino");
      writeFileSync(fake, "#!/bin/sh\nexit 5\n");
      chmodSync(fake, 0o755);
      try {
        const result = spawnSync(
          process.execPath,
          [join(shellDir, "bin", "refino.js"), "--version"],
          {
            encoding: "utf8",
          },
        );
        expect(result.status).toBe(5);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("missingBinaryError", () => {
  it("is actionable: names the expected packages and the remedies", () => {
    const message = missingBinaryError(["win32-x64"]);
    expect(message).toContain("@refino/cli-win32-x64");
    expect(message).toContain("--omit=optional");
    expect(message).toContain("REFINO_BINARY_PATH");
  });
});

describe("bin passthrough", () => {
  it(
    "execs REFINO_BINARY_PATH and propagates its exit code",
    { skip: process.platform === "win32" },
    () => {
      const dir = mkdtempSync(join(tmpdir(), "refino-shell-"));
      const fake = join(dir, "fake-refino.sh");
      writeFileSync(fake, "#!/bin/sh\nexit 7\n");
      chmodSync(fake, 0o755);
      const bin = require.resolve("../bin/refino.js");
      try {
        const result = spawnSync(process.execPath, [bin, "--version"], {
          env: { ...process.env, REFINO_BINARY_PATH: fake },
        });
        expect(result.status).toBe(7);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
