import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "@shaderfrog/glsl-parser";
import type { KeywordNode } from "@shaderfrog/glsl-parser/ast/ast-types.js";
import edgeFragment from "../src/graph/render/glsl/edge.frag?raw";
import edgeVertex from "../src/graph/render/glsl/edge.vert?raw";
import nodeFragment from "../src/graph/render/glsl/node.frag?raw";
import nodeVertex from "../src/graph/render/glsl/node.vert?raw";
import textFragment from "../src/graph/render/glsl/text.frag?raw";
import textVertex from "../src/graph/render/glsl/text.vert?raw";
import glslangValidator from "glslang-validator-prebuilt-predownloaded";

const run = promisify(execFile);

const PROGRAMS = [
  ["edge", edgeVertex, edgeFragment],
  ["node", nodeVertex, nodeFragment],
  ["text", textVertex, textFragment],
] as const;

/** Cross-stage interface variables (`out` in the vertex stage, `in` in the
 * fragment stage) declared at global scope, by name. Uniforms and vertex
 * attributes are inputs to a single stage, not the interface. */
function interfaceVariables(source: string, qualifier: "in" | "out"): Map<string, string> {
  const found = new Map<string, string>();
  for (const statement of parse(source).program) {
    if (statement.type !== "declaration_statement") continue;
    const { declaration } = statement;
    if (declaration.type !== "declarator_list") continue;
    const tokens = (declaration.specified_type.qualifiers ?? [])
      .filter((node): node is KeywordNode => node.type === "keyword")
      .map((node) => node.token);
    if (!tokens.includes(qualifier)) continue;
    const type = declaration.specified_type.specifier.specifier.token;
    for (const declarator of declaration.declarations) {
      const arraySuffix = (declarator.quantifier ?? []).length > 0 ? "[]" : "";
      found.set(declarator.identifier.identifier, type + arraySuffix);
    }
  }
  return found;
}

/** The glslangValidator binary for this platform, or null where the
 * prebuilt-package binaries do not exist (e.g. Linux arm64). */
function validatorPath(): string | null {
  try {
    return glslangValidator.getPath();
  } catch {
    return null;
  }
}

describe("glsl shader sources", () => {
  const directory = mkdtempSync(join(tmpdir(), "refino-glsl-"));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  for (const [name, vertex, fragment] of PROGRAMS) {
    writeFileSync(join(directory, `${name}.vert`), vertex);
    writeFileSync(join(directory, `${name}.frag`), fragment);

    it(`${name}: vertex outputs match fragment inputs`, () => {
      const outs = interfaceVariables(vertex, "out");
      const ins = interfaceVariables(fragment, "in");
      expect([...outs.entries()].sort()).toEqual([...ins.entries()].sort());
    });
  }

  const glslang = validatorPath();
  // The npm tarball loses the executable bit; restore it before spawning
  // (nothing to do on Windows, where the binary is a .exe).
  if (glslang !== null && process.platform !== "win32") chmodSync(glslang, 0o755);

  (glslang === null ? it.skip : it).each(PROGRAMS.map(([name]) => name))(
    "%s: glslangValidator compiles and links the pair",
    async (name) => {
      const files = [join(directory, `${name}.vert`), join(directory, `${name}.frag`)];
      try {
        await run(glslang!, ["-l", ...files]);
      } catch (error) {
        const detail = (error as { stderr?: unknown }).stderr;
        throw new Error(
          `glslangValidator rejected the ${name} program:\n${String(detail ?? error)}`,
          { cause: error },
        );
      }
    },
  );
});
