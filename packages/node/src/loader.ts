import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildGraph, parseNodeSource, RefinoError } from "refino";
import type { LoadResult, NodeType, RefinoIssue, RefinoNode } from "refino";

const STORAGE_DIRS: ReadonlyArray<readonly [string, NodeType]> = [
  ["premises", "premise"],
  ["constraints", "constraint"],
];

/**
 * Read every node file under a `.refino` directory and build the in-memory
 * graph. Loading is read-only; the only write path is `writer.ts`.
 *
 * Parse-level issues (including duplicate ids) are collected in `issues`;
 * nodes that could not be identified are skipped. Structural validation
 * (unknown grounds, cycles) is a separate step: `validateGraph`.
 */
export async function loadGraph(refinoDir: string): Promise<LoadResult> {
  let dirStat;
  try {
    dirStat = await stat(refinoDir);
  } catch {
    throw new RefinoError("REFINO_DIR_NOT_FOUND", `No .refino directory found at ${refinoDir}`);
  }
  if (!dirStat.isDirectory()) {
    throw new RefinoError("REFINO_DIR_NOT_FOUND", `${refinoDir} is not a directory`);
  }

  const nodes: RefinoNode[] = [];
  const issues: RefinoIssue[] = [];
  const seenIds = new Map<string, string>();

  for (const [dirName, expectedType] of STORAGE_DIRS) {
    let entries;
    try {
      entries = await readdir(join(refinoDir, dirName), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // subdir optional
      throw error;
    }
    for (const entry of entries.sort(byName)) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const file = `${dirName}/${entry.name}`;
      let source: string;
      try {
        source = await readFile(join(refinoDir, file), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // changed mid-scan
        throw error;
      }
      const { node, issues: parseIssues } = parseNodeSource(file, expectedType, source);
      issues.push(...parseIssues);
      if (!node) continue;
      const existingFile = seenIds.get(node.id);
      if (existingFile) {
        issues.push({
          code: "DUPLICATE_ID",
          message: `Duplicate node id "${node.id}" (already defined in ${existingFile}).`,
          file: node.file,
          nodeId: node.id,
        });
        continue;
      }
      seenIds.set(node.id, node.file);
      nodes.push(node);
    }
  }

  return { graph: buildGraph(refinoDir, nodes), issues };
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
