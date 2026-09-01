import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Keys are `.refino`-relative paths, e.g. `constraints/01ABCDEF.md`.
 *  Returns the project root; the storage directory is `<root>/.refino`. */
export async function createRefino(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "refino-test-"));
  for (const [relative, content] of Object.entries(files)) {
    const file = join(root, ".refino", relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }
  return root;
}

export async function removeRefino(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

/** A premise node file body; the id lives in the file name, not the frontmatter. */
export function premise(_id: string, body = "body."): string {
  return `${body}\n`;
}

/** A constraint node file body; the id lives in the file name, not the frontmatter. */
export function constraint(
  _id: string,
  grounds: readonly string[] | undefined,
  body = "body.",
  rationale?: string,
): string {
  const lines: string[] = [];
  if (grounds !== undefined || rationale !== undefined) {
    lines.push("---");
    if (grounds !== undefined) lines.push(`grounds: [${grounds.join(", ")}]`);
    if (rationale !== undefined) lines.push(`rationale: ${JSON.stringify(rationale)}`);
    lines.push("---", "");
  }
  lines.push(`${body}\n`);
  return lines.join("\n");
}
