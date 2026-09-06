import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Git access for `refino pending`: the only place in the CLI that shells out
 * to an external process. Scoped to pathspecs under `.refino/nodes/` — the
 * commands never read anything outside the adopted store.
 */
export type GitError = { code: "GIT_UNAVAILABLE" } | { code: "NOT_A_REPO"; root: string };

/** Run git in the given root; a missing binary maps to GIT_UNAVAILABLE. */
export async function git(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", root, ...args], { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const e: GitError = { code: "GIT_UNAVAILABLE" };
      throw e;
    }
    throw error;
  }
}

export function isGitUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as GitError).code === "GIT_UNAVAILABLE"
  );
}
