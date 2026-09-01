import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseNodeSource } from "./parser.js";
import { RefinoError } from "./types.js";
import type { Graph, LoadResult, NodeType, RefinoIssue, RefinoNode } from "./types.js";

const STORAGE_DIRS: ReadonlyArray<readonly [string, NodeType]> = [
  ["premises", "premise"],
  ["constraints", "constraint"],
];

/**
 * Read every node file under a `.refino` directory and build the in-memory
 * graph. This is the only filesystem access the engine performs; no runtime
 * state is ever written back.
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

  const nodes = new Map<string, RefinoNode>();
  const issues: RefinoIssue[] = [];

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
      const existing = nodes.get(node.id);
      if (existing) {
        issues.push({
          code: "DUPLICATE_ID",
          message: `Duplicate node id "${node.id}" (already defined in ${existing.file}).`,
          file: node.file,
          nodeId: node.id,
        });
        continue;
      }
      nodes.set(node.id, node);
    }
  }

  const graph: Graph = { refinoDir, nodes, dependents: buildDependentsIndex(nodes) };
  return { graph, issues };
}

function buildDependentsIndex(nodes: Graph["nodes"]): Graph["dependents"] {
  const dependents = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (node.type !== "constraint") continue;
    for (const ground of node.grounds ?? []) {
      const list = dependents.get(ground);
      if (list) {
        if (!list.includes(node.id)) list.push(node.id);
      } else {
        dependents.set(ground, [node.id]);
      }
    }
  }
  for (const list of dependents.values()) list.sort();
  return dependents;
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
