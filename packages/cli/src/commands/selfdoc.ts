import { Command } from "commander";
import { guideText, skillText } from "../selfdoc.js";
import type { RunFn } from "../shared.js";
import type { CliIo } from "../format.js";

/**
 * `refino guide` and `refino skill` — pure stdout emitters of the
 * model-facing self-documentation (docs/design.md, "通用接入形态"). They
 * never touch the filesystem: installing the skill into a harness is the
 * model's job, guided by the emitted instructions, so refino stays neutral
 * about hosts.
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

export function createSkillCommand(io: CliIo, run: RunFn): Command {
  return new Command("skill")
    .description("print the SKILL.md content and how to install it (pure stdout emitter)")
    .action((_opts, cmd: Command) =>
      run(cmd, async () => {
        io.stdout.write(`${skillText()}\n`);
        return 0;
      }),
    );
}
