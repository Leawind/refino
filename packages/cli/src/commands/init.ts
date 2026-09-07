import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { ensureStateIgnored } from "../authorization.js";
import { emit, refinoDir } from "../shared.js";
import type { GlobalOptions, RunFn } from "../shared.js";
import type { CliIo } from "../format.js";

/**
 * `refino init` — create the `.refino/` skeleton: the `nodes/` graph
 * directory plus the committed `.gitignore` that keeps the state lane
 * (`state/`) out of version control. Pure scaffolding: the CRG starts empty,
 * and the first `refino new` writes the first node file. An existing
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
