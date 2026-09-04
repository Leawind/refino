import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Locate the `.refino` directory for a session working directory: the nearest
 * ancestor (cwd included) containing a `.refino` directory. Undefined when no
 * ancestor has one, in which case the plugin leaves the agent untouched.
 */
export async function findRefinoDir(cwd: string): Promise<string | undefined> {
  let current = cwd;
  for (;;) {
    const candidate = join(current, ".refino");
    if (await isDirectory(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
