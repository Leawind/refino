#!/usr/bin/env node
"use strict";

/**
 * Distribution shell for the native refino binary (docs/design.md,
 * "命令行工具": the npm channel is a shell that resolves the platform
 * binary; the command surface itself lives in the Rust crate).
 *
 * The platform package (@refino/cli-<platform>-<arch>) is installed as an
 * optional dependency pinned to the shell's exact version — the esbuild /
 * Biome convention. There is deliberately no postinstall: modern npm, pnpm
 * and yarn all resolve optionalDependencies correctly, and a verification
 * script would break --ignore-scripts installs. A broken install surfaces
 * here as an actionable error instead.
 *
 * REFINO_BINARY_PATH overrides resolution entirely (development and CI
 * against a locally built binary), mirroring esbuild's ESBUILD_BINARY_PATH.
 */

const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");
const os = require("node:os");

const shellVersion = require("../package.json").version;
const scope = "@refino/cli";

/**
 * Whether the running linux is musl-based: process.report carries the glibc
 * runtime version, and its absence is the portable musl signal (no `ldd`
 * subprocess needed).
 */
function isMusl(platform, report) {
  if (platform !== "linux") return false;
  try {
    const header = (report ?? process.report?.getReport?.())?.header;
    return !header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

/**
 * Platform-package name suffixes for the running host, most specific first.
 * On linux both libc flavors are tried — a static musl binary runs on glibc
 * too, so the order only prefers the flavor that matches the host first.
 * Empty when the platform is unsupported.
 */
function candidateNames(
  platform = process.platform,
  arch = process.arch,
  musl = isMusl(process.platform),
) {
  if (platform === "win32") return arch === "x64" || arch === "arm64" ? [`win32-${arch}`] : [];
  if (platform === "darwin") return arch === "x64" || arch === "arm64" ? [`darwin-${arch}`] : [];
  if (platform === "linux") {
    if (arch !== "x64" && arch !== "arm64") return [];
    const base = `linux-${arch}`;
    return musl ? [`${base}-musl`, base] : [base, `${base}-musl`];
  }
  return [];
}

function binarySubpath(platform = process.platform) {
  return platform === "win32" ? "bin/refino.exe" : "bin/refino";
}

/**
 * Resolve the platform binary through the candidate list. `resolve` is
 * injectable for tests; it throws when a package (or its subpath) is absent.
 * Returns the binary path and its package name, or undefined when nothing
 * resolves.
 */
function resolveBinaryPath({
  platform = process.platform,
  arch = process.arch,
  musl,
  resolve = require.resolve,
} = {}) {
  const candidates = candidateNames(platform, arch, musl);
  for (const suffix of candidates) {
    const packageName = `${scope}-${suffix}`;
    try {
      const resolved = resolve(`${packageName}/${binarySubpath(platform)}`);
      if (resolved) return { path: resolved, packageName };
    } catch {
      // not installed (optional dependencies skipped or filtered) — try the
      // next libc flavor before giving up
    }
  }
  return undefined;
}

/**
 * A resolved platform package at a different version than the shell means a
 * broken or mixed install; warn rather than run silently against a mismatched
 * binary.
 */
function warnVersionMismatch(packageName, resolve, log = process.stderr) {
  try {
    const manifest = JSON.parse(
      require("node:fs").readFileSync(resolve(`${packageName}/package.json`), "utf8"),
    );
    if (manifest.version !== shellVersion) {
      log.write(
        `warning: ${packageName} is version ${manifest.version} but @refino/cli is ${shellVersion}; reinstall @refino/cli to fix the install\n`,
      );
    }
  } catch {
    // manifest unreadable — the binary itself will tell more if it is broken
  }
}

/**
 * The native server finds the UI under the project tree or in REFINO_UI_DIR;
 * a global npm install keeps @refino/ui outside that tree, so resolve the
 * dependency here (Node resolution, which every package manager supports) and
 * hand the path to the child. An explicit REFINO_UI_DIR always wins.
 */
function withUiDir(env = process.env, resolve = require.resolve, exists = existsSync) {
  if (env.REFINO_UI_DIR) return env;
  try {
    const dist = join(dirname(resolve("@refino/ui/package.json")), "dist");
    return exists(dist) ? { ...env, REFINO_UI_DIR: dist } : env;
  } catch {
    return env;
  }
}

/** Spawn the native binary with inherited stdio; return the exit code. */
function runBinary(binaryPath, argv, env = process.env) {
  const result = spawnSync(binaryPath, argv, { stdio: "inherit", env });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      process.stderr.write(`error: resolved binary is missing on disk: ${binaryPath}\n`);
    } else {
      process.stderr.write(`error: cannot run ${binaryPath}: ${result.error.message}\n`);
    }
    return 1;
  }
  if (typeof result.status === "number") return result.status;
  // Terminated by a signal — follow the 128+n convention so callers can
  // distinguish, e.g., SIGINT (130) from a normal failure.
  const number = os.constants.signals[result.signal ?? ""];
  return 128 + (number ?? 1);
}

function missingBinaryError(candidates) {
  const flavor = isMusl() ? "musl" : "glibc";
  return [
    `error: no refino binary for ${process.platform}-${process.arch} (${flavor}) was installed.`,
    "",
    `Expected one of: ${candidates.map((suffix) => `${scope}-${suffix}`).join(", ")} (as an optional dependency of ${scope}).`,
    "",
    "Common causes and fixes:",
    "- npm: reinstall without --omit=optional / --no-optional",
    "- yarn: node_modules was copied between machines or supportedArchitectures filtered it — run yarn install again",
    "- unsupported libc (e.g. musl): build from source (cargo install refino) or set REFINO_BINARY_PATH",
    "",
    "REFINO_BINARY_PATH=<path> always overrides resolution.",
  ].join("\n");
}

function main(argv = process.argv.slice(2), env = process.env) {
  const childEnv = withUiDir(env);
  const override = env.REFINO_BINARY_PATH;
  if (override) return runBinary(override, argv, childEnv);

  const found = resolveBinaryPath();
  if (!found) {
    process.stderr.write(`${missingBinaryError(candidateNames())}\n`);
    return 1;
  }
  warnVersionMismatch(found.packageName, require.resolve);
  return runBinary(found.path, argv, childEnv);
}

module.exports = {
  candidateNames,
  isMusl,
  resolveBinaryPath,
  runBinary,
  missingBinaryError,
  withUiDir,
  main,
};

if (require.main === module) {
  process.exit(main());
}
