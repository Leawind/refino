import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Keys are `.refino`-relative paths, e.g. `constraints/C-001.md`.
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

export function premise(id: string, body = `${id} body.`): string {
  return `---\nid: ${id}\ntype: premise\n---\n\n${body}\n`;
}

export function constraint(
  id: string,
  grounds: readonly string[] | undefined,
  body = `${id} body.`,
): string {
  const groundsLine = grounds === undefined ? "" : `grounds: [${grounds.join(", ")}]\n`;
  return `---\nid: ${id}\ntype: constraint\n${groundsLine}---\n\n${body}\n`;
}
