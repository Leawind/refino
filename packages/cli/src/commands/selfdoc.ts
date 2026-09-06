import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { guideText, skillMarkdown, skillText } from "../selfdoc.js";
import { emit } from "../shared.js";
import type { GlobalOptions, RunFn } from "../shared.js";
import type { CliIo } from "../format.js";

/**
 * `refino guide` and `refino skill` — emitters of the model-facing
 * self-documentation (docs/design.md, "通用接入形态"). `guide` and plain
 * `skill` are pure stdout; `skill --output <dir>` materializes the skill
 * directory at the model-supplied path — the only file write in the command
 * surface. refino never probes host skill directories: picking the path and
 * registering the skill with the host stays the model's job.
 */
export function createGuideCommand(io: CliIo, run: RunFn): Command {
  return new Command("guide")
    .description("print the full working protocol (written for models)")
    .action((_opts, cmd: Command) =>
      run(cmd, async () => {
        io.stdout.write(`${guideText()}\n`);
        return 0;
      }),
    );
}

interface SkillOptions extends GlobalOptions {
  /** Target directory; the skill is written as <dir>/refino/SKILL.md. */
  output?: string;
}

export function createSkillCommand(io: CliIo, run: RunFn): Command {
  return new Command("skill")
    .description("print the SKILL.md content with install guidance")
    .option("--output <dir>", "write the skill as <dir>/refino/SKILL.md instead of printing it")
    .action((_opts, cmd: Command) =>
      run(cmd, async (opts: SkillOptions) => {
        if (opts.output === undefined) {
          io.stdout.write(`${skillText()}\n`);
          return 0;
        }
        // Directory name is always "refino": the Agent Skills spec requires
        // it to match the `name` frontmatter field.
        const dir = join(opts.output, "refino");
        const file = join(dir, "SKILL.md");
        await mkdir(dir, { recursive: true });
        await writeFile(file, skillMarkdown(), "utf8");
        if (opts.json) emit(io, { wrote: file });
        else
          io.stdout.write(
            `wrote ${file} (register it with your skill mechanism, then run "refino guide")\n`,
          );
        return 0;
      }),
    );
}
