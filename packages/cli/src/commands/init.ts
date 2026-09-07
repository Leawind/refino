import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { emit, refinoDir } from "../shared.js";
import type { GlobalOptions, RunFn } from "../shared.js";
import type { CliIo } from "../format.js";

/** The anchored gitignore rule that keeps the state lane unversioned. */
const GITIGNORE_RULE = "/state/";

const GITIGNORE_TEXT = `# refino workspace state (signed authorizations; machine-local, not shared)\n${GITIGNORE_RULE}\n`;

/**
 * Seed the committed `.gitignore` that keeps the state lane (`state/`) out of
 * version control. Scaffolding only, done once at adoption: the write path
 * never touches this file, so a user removing the rule — to manage ignores at
 * an upper level, or to version `state/` deliberately — has the last word.
 * Idempotent: a missing file is created, an existing file without the rule
 * gains it appended.
 */
export async function ensureStateIgnored(refinoDir: string): Promise<void> {
  const file = join(refinoDir, ".gitignore");
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(file, GITIGNORE_TEXT, "utf8");
    return;
  }
  if (content.split(/\r?\n/).some((line) => line.trim() === GITIGNORE_RULE)) return;
  const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  await writeFile(file, `${content}${separator}${GITIGNORE_RULE}\n`, "utf8");
}

/**
 * `refino init` — create the `.refino/` skeleton: the `nodes/` graph
 * directory plus the committed `.gitignore` that keeps the state lane
 * (`state/`) out of version control. Pure scaffolding: the CRG starts empty, * and the first `refino new` writes the first node file. An existing
 * `.refino/` is an error so the caller never mistakes an adopted repository
 * for a fresh one.
 */
export function createInitCommand(io: CliIo, run: RunFn): Command {
  return new Command("init")
    .description("create the .refino/ directory skeleton (pure scaffolding)")
    .action((_opts, cmd: Command) =>
      run(cmd, async (opts: GlobalOptions) => {
        const dir = refinoDir(opts);
        try {
          await mkdir(dir); // no recursive: EEXIST is the interesting case
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            io.stderr.write(`error: ${dir} already exists (nothing to initialize)\n`);
            return 1;
          }
          throw error;
        }
        await mkdir(join(dir, "nodes"), { recursive: true });
        await ensureStateIgnored(dir);
        if (opts.json) emit(io, { refinoDir: dir, created: true });
        else io.stdout.write(`initialized ${dir} (empty graph; create nodes with "refino new")\n`);
        return 0;
      }),
    );
}
