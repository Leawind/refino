import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract layer: the plugin's artifacts encode everything the host needs
 * to load it. Each assertion here is a belief about the host interface
 * (hook event names, template variables, manifest rules) — when either the
 * artifacts or the beliefs drift, this file names the drift precisely.
 */

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(pkgRoot, relative), "utf8")) as Record<string, unknown>;
}

/** Template variables the host expands in plugin-provided MCP and hook commands. */
const SUPPORTED_TEMPLATE_VARS = new Set([
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PROJECT_DIR",
  "ZCODE_PLUGIN_ROOT",
  "ZCODE_PROJECT_DIR",
]);

/** The host's hook events (exactly seven; anything else never fires). */
const SUPPORTED_HOOK_EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
]);

function templateVars(text: string): string[] {
  return [...text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]!);
}

describe("plugin manifest", () => {
  it("carries a name the host accepts and a skills directory that exists", () => {
    const manifest = readJson(".claude-plugin/plugin.json");
    expect(manifest.name).toMatch(/^[a-z0-9][a-z0-9._-]{0,127}$/);
    expect(manifest.name).toBe("refino");
    expect(typeof manifest.version).toBe("string");
    expect(statSync(join(pkgRoot, manifest.skills as string)).isDirectory()).toBe(true);
  });
});

describe("plugin MCP declaration (.mcp.json)", () => {
  it("starts the bundled server with node and only supported template variables", () => {
    const servers = readJson(".mcp.json");
    expect(Object.keys(servers)).toEqual(["refino"]);
    const server = servers.refino as Record<string, unknown>;
    expect(server.type).toBe("stdio");
    expect(server.command).toBe("node");
    expect(server.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/dist/mcp.js"]);
    // The workspace directory the server locates `.refino/` from.
    expect(server.cwd).toBe("${CLAUDE_PROJECT_DIR}");
    const vars = templateVars(JSON.stringify(servers));
    expect(vars.every((name) => SUPPORTED_TEMPLATE_VARS.has(name))).toBe(true);
  });
});

describe("hook declarations (hooks/hooks.json)", () => {
  const hooks = readJson("hooks/hooks.json") as {
    hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
  };

  it("uses only supported events and mounts every consumption point", () => {
    const events = Object.keys(hooks.hooks);
    for (const event of events) {
      expect(SUPPORTED_HOOK_EVENTS.has(event)).toBe(true);
    }
    // The freshness contract: the queue is drained after every tool call
    // (in-turn) and at every user message (fallback), plus the baseline
    // injection at session start.
    expect(events).toEqual(["SessionStart", "UserPromptSubmit", "PostToolUse"]);
  });

  it("runs the built hook via node with a subcommand and a sane timeout", () => {
    const expected: Record<string, string> = {
      SessionStart: "session-start",
      UserPromptSubmit: "sync",
      PostToolUse: "sync",
    };
    for (const [event, groups] of Object.entries(hooks.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          expect(hook.type).toBe("command");
          expect(hook.command).toBe(
            `node "\${CLAUDE_PLUGIN_ROOT}/dist/hook.js" ${expected[event]}`,
          );
          // Command-style timeouts are in seconds.
          const timeout = hook.timeout as number;
          expect(timeout).toBeGreaterThan(0);
          expect(timeout).toBeLessThanOrEqual(600);
          const vars = templateVars(hook.command as string);
          expect(vars.every((name) => SUPPORTED_TEMPLATE_VARS.has(name))).toBe(true);
        }
      }
    }
  });
});

describe("skill", () => {
  it("ships a SKILL.md with the expected frontmatter", () => {
    const file = join(pkgRoot, "skills/refino-crg/SKILL.md");
    expect(existsSync(file)).toBe(true);
    const frontmatter = readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    expect(frontmatter).toContain("name: refino-crg");
    expect(frontmatter).toContain("description:");
  });

  it("cites tools by short name only (host prefixes belong to the host)", () => {
    // The host injects the full model-side tool names into the tool list
    // itself; a hard-coded prefix here would drift per host (ZCode does not
    // surface `mcp__refino__<tool>`).
    const text = readFileSync(join(pkgRoot, "skills/refino-crg/SKILL.md"), "utf8");
    expect(text).not.toContain("mcp__");
    expect(text).toContain("`request_authorization`");
    expect(text).toContain("`pending_review`");
  });
});
