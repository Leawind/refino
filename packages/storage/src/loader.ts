import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildGraph, ID_RE, RefinoError } from "refino";
import { parseNodeSource } from "./parser.js";
import { nodeFilePath, nodeRelativeFile, NODE_TYPES } from "./writer.js";
import type { Graph, NodeType, RefinoIssue, RefinoNode } from "refino";

const NODES_DIR = "nodes";

/** A shard directory name: the first 2 characters of a node id. */
const SHARD_RE = /^[0-9A-HJKMNP-TV-Z]{2}$/;

/** A node file base name: the last 6 characters of a node id. */
const SHARD_FILE_RE = /^[0-9A-HJKMNP-TV-Z]{6}$/;

export interface LoadResult {
  graph: Graph;
  /** Issues found while reading and parsing node files (including duplicate ids). */
  issues: RefinoIssue[];
}

export interface ReadNodeResult {
  /** The parsed node, or null when neither candidate file exists. */
  node: RefinoNode | null;
  issues: RefinoIssue[];
}

/**
 * Read a single node by id (path is identity): parse whichever of the two
 * candidate files exists. Incremental index updates use this instead of a
 * full rescan, so parse logic stays single-sourced in the storage layer.
 *
 * Candidate order mirrors loadGraph's within-shard lexicographic scan
 * ("constraint" sorts before "premise"), so single-node reads agree with
 * full loads: parse issues from every existing candidate are reported, the
 * first candidate yielding a valid node wins, and a second valid candidate
 * is reported as DUPLICATE_ID.
 */
export async function readNode(refinoDir: string, id: string): Promise<ReadNodeResult> {
  if (!ID_RE.test(id)) {
    throw new RefinoError(
      "INVALID_ID",
      `Node id must be an 8-character Crockford base32 id (0-9, A-Z minus I, L, O, U), got "${id}".`,
    );
  }
  const candidates = [...NODE_TYPES].sort().map((type) => ({
    type,
    file: nodeRelativeFile(type, id),
    absolute: nodeFilePath(refinoDir, type, id),
  }));
  const issues: RefinoIssue[] = [];
  let node: RefinoNode | null = null;
  for (const candidate of candidates) {
    let source: string;
    try {
      source = await readFile(candidate.absolute, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // no file of this type
      throw error;
    }
    const parsed = parseNodeSource(id, candidate.file, candidate.type, source);
    issues.push(...parsed.issues);
    if (parsed.node === null) continue;
    if (node === null) {
      node = parsed.node;
    } else {
      issues.push({
        code: "DUPLICATE_ID",
        message: `Duplicate node id "${id}" (already defined in ${node.file}).`,
        file: parsed.node.file,
        nodeId: id,
      });
      break; // both candidates parsed: nothing left to read
    }
  }
  return { node, issues };
}

/**
 * Read every node file under `<refinoDir>/nodes/` and build the in-memory
 * graph. Loading is read-only; the only write path is `writer.ts`.
 *
 * Layout: `nodes/<2-char shard>/<6-char id>.<type>.md`, where `<type>` is
 * `premise` or `constraint`. The node id is derived from the file path
 * (path is identity): shard directory name + file base name, so shard and
 * base always combine into a valid id and the type travels in the file
 * name, never in the frontmatter.
 *
 * Directory names that are not valid shards and non-markdown files are
 * silently ignored; nested files are ignored; stray markdown files at the
 * top of `nodes/` and files whose name has no valid `<base>.<type>` shape
 * are reported as INVALID_NODE_PATH; base names that are not 6 Crockford
 * base32 characters are reported as INVALID_ID. A missing `nodes/`
 * directory is an empty graph. Structural validation (unknown grounds,
 * cycles) is a separate step: `validateGraph`.
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

  let shards;
  try {
    shards = await readdir(join(refinoDir, NODES_DIR), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { graph: buildGraph(refinoDir, []), issues }; // empty store
    }
    throw error;
  }

  for (const shard of shards.sort(byName)) {
    if (shard.isFile() && shard.name.endsWith(".md")) {
      const file = `${NODES_DIR}/${shard.name}`;
      issues.push({
        code: "INVALID_NODE_PATH",
        message: `Node files must live at ${NODES_DIR}/<shard>/<id>.<type>.md, e.g. ${NODES_DIR}/01/9ABCDE.premise.md; got "${file}".`,
        file,
      });
      continue;
    }
    if (!shard.isDirectory() || !SHARD_RE.test(shard.name)) continue; // silently ignored
    let files;
    try {
      files = await readdir(join(refinoDir, NODES_DIR, shard.name), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // changed mid-scan
      throw error;
    }
    for (const entry of files.sort(byName)) {
      // Deeper directories and non-markdown files are silently ignored.
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const file = `${NODES_DIR}/${shard.name}/${entry.name}`;
      let source: string;
      try {
        source = await readFile(join(refinoDir, file), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // changed mid-scan
        throw error;
      }
      const parsed = parseFileName(entry.name.slice(0, -".md".length));
      if (!parsed) {
        issues.push({
          code: "INVALID_NODE_PATH",
          message: `Node file names must be <6-char id>.<type>.md with <type> one of ${NODE_TYPES.join("|")}, got "${entry.name}".`,
          file,
        });
        continue;
      }
      const { base, type } = parsed;
      if (!SHARD_FILE_RE.test(base)) {
        issues.push({
          code: "INVALID_ID",
          message: `Node file base name must be 6 Crockford base32 characters (the id is shard + base), got "${base}".`,
          file,
        });
        continue;
      }
      const id = shard.name + base;
      const { node, issues: parseIssues } = parseNodeSource(id, file, type, source);
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

/** Split `<base>.<type>` into its parts; null when the shape is wrong. */
function parseFileName(name: string): { base: string; type: NodeType } | null {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return null;
  const type = name.slice(dot + 1);
  if (type !== "premise" && type !== "constraint") return null;
  return { base: name.slice(0, dot), type };
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
