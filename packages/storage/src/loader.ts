import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildGraph, ID_RE, RefinoError } from "refino";
import { parseNodeSource } from "./parser.js";
import type { Graph, NodeType, RefinoIssue, RefinoNode } from "refino";

const STORAGE_DIRS: ReadonlyArray<readonly [string, NodeType]> = [
  ["premises", "premise"],
  ["constraints", "constraint"],
];

/** A shard directory name: the first 2 characters of a node id. */
const SHARD_RE = /^[0-9A-HJKMNP-TV-Z]{2}$/;

/** A node file name (without `.md`): the last 6 characters of a node id. */
const SHARD_FILE_RE = /^[0-9A-HJKMNP-TV-Z]{6}$/;

export interface LoadResult {
  graph: Graph;
  /** Issues found while reading and parsing node files (including duplicate ids). */
  issues: RefinoIssue[];
}

/**
 * Read every node file under a `.refino` directory and build the in-memory
 * graph. Loading is read-only; the only write path is `writer.ts`.
 *
 * Layout: `<type>/<2-char shard>/<6-char id>.md`. The node id is derived
 * from the file path (path is identity), so shard and file name always
 * combine into a valid id. Top-level directories that are not valid shards
 * and non-markdown files are silently ignored; stray top-level node files
 * (old layout leftovers) are reported as INVALID_NODE_PATH. Structural
 * validation (unknown grounds, cycles) is a separate step: `validateGraph`.
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
    let shards;
    try {
      shards = await readdir(join(refinoDir, dirName), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // subdir optional
      throw error;
    }
    for (const shard of shards.sort(byName)) {
      if (shard.isFile() && shard.name.endsWith(".md")) {
        const file = `${dirName}/${shard.name}`;
        issues.push({
          code: "INVALID_NODE_PATH",
          message: `Node files must live at <type>/<shard>/<id>.md, e.g. ${dirName}/01/9ABCDE.md; got "${file}".`,
          file,
        });
        continue;
      }
      if (!shard.isDirectory() || !SHARD_RE.test(shard.name)) continue; // silently ignored
      let files;
      try {
        files = await readdir(join(refinoDir, dirName, shard.name), { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // changed mid-scan
        throw error;
      }
      for (const entry of files.sort(byName)) {
        // Deeper directories and non-markdown files are silently ignored.
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const file = `${dirName}/${shard.name}/${entry.name}`;
        let source: string;
        try {
          source = await readFile(join(refinoDir, file), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // changed mid-scan
          throw error;
        }
        const baseName = entry.name.slice(0, -".md".length);
        if (!SHARD_FILE_RE.test(baseName)) {
          issues.push({
            code: "INVALID_ID",
            message: `Node file name must be 6 Crockford base32 characters (the id is shard + file name), got "${baseName}".`,
            file,
          });
          continue;
        }
        const id = shard.name + baseName;
        const { node, issues: parseIssues } = parseNodeSource(id, file, expectedType, source);
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
  }

  return { graph: buildGraph(refinoDir, nodes), issues };
}

/** All ids of existing node files across both storage directory trees. */
export async function readAllExistingIds(refinoDir: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const [dirName] of STORAGE_DIRS) {
    let shards;
    try {
      shards = await readdir(join(refinoDir, dirName), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // subdir optional
      throw error;
    }
    for (const shard of shards.sort(byName)) {
      if (!shard.isDirectory() || !SHARD_RE.test(shard.name)) continue;
      let files;
      try {
        files = await readdir(join(refinoDir, dirName, shard.name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of files) {
        if (!entry.endsWith(".md")) continue;
        const baseName = entry.slice(0, -".md".length);
        const id = shard.name + baseName;
        if (ID_RE.test(id)) ids.add(id);
      }
    }
  }
  return ids;
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
